/**
 * "Programma con API OpenAI" (kind 'command'): any program that serves the OpenAI API, started from
 * the user's commands (contract/custom-engines.ts): optional commands before the server, the server,
 * optional commands after it (steps.ts). LLM Bench fills in the placeholders, runs the commands before,
 * starts the server, waits for /v1/models, measures it like an external endpoint (text prompts, usage
 * counts), stops it and runs the commands after. Only the processes it started are ever stopped: the
 * server is recorded in the ownership registry like every engine process, and verified by the marker
 * in its command line after a crash ({alias}); without {alias} a leftover is left alone rather than
 * guessed at.
 *
 * The placeholders of LLM Bench settings ({ctx}, {kv}, {parallel}, {gpuLayers}, {batch}, {ubatch}) take
 * the run's values, or COMMAND_DEFAULTS when it leaves them unset; the plan keeps only the settings
 * the commands take (commandParams), so results show back what really reached the program.
 *
 * Every command is split into arguments before its placeholders are filled and runs as an argv array,
 * never through a shell: a model path with spaces stays one argument and no value can start another
 * command. Nothing runs to check the programs (a `--version` could start a server): the commands are
 * validated and each program looked up on disk or on PATH.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  commandKvTypes,
  commandParams,
  commandSettings,
  commandSettingValues,
  commandStepsOf,
  expandCommandTemplate,
  splitCommandLine,
  templateProblem,
  type CommandPlaceholder,
  type CommandRun,
} from '../../../contract/custom-engines';
import type { EngineStatus, LaunchParams } from '../../../contract/engines';
import { AppError, toAppErrorData } from '../../../contract/errors';
import type { EngineIdentity } from '../../../contract/results';
import type { CoreDeps, ExitInfo, ManagedProcess, Platform } from '../../deps';
import type { InferenceClient } from '../../inference/types';
import type { OwnedRecord, OwnershipRegistry } from '../../process/ownership';
import { LOOPBACK } from '../../process/ports';
import { chatKwargsOf } from '../shared/reasoning-vision';
import { createProcessInstance, type ClientFactory } from '../instance';
import { listsModel } from '../shared/probes';
import type { CoreEngineConfig, EngineAdapter, EngineCaps, EngineInstance, LaunchPlan, ModelTarget, PlanOptions } from '../types';
import { weightFiles } from '../types';
import { createSteppedInstance } from './steps';

export type CommandDeps = Pick<CoreDeps, 'clock' | 'proc' | 'fetch' | 'platform' | 'log' | 'env'>;

export interface CommandAdapterOptions {
  deps: CommandDeps;
  createClient: ClientFactory;
  ownership?: Pick<OwnershipRegistry, 'add' | 'remove'>;
  readyTimeoutMs?: number;
  pollMs?: number;
  /** Whether a path is a file (the real disk by default): tests check Windows' rules on any system. */
  isFile?: IsFile;
  /** Time limits of a command before the server and of one after it (steps.ts defaults). */
  beforeTimeoutMs?: number;
  afterTimeoutMs?: number;
}

export type IsFile = (f: string) => Promise<boolean>;

const isFileOnDisk: IsFile = async (f) => (await fs.stat(f).catch(() => undefined))?.isFile() === true;

const PROBE_TIMEOUT_MS = 5000;

/** `name` as a file: a path (relative to the working folder) or a name found on PATH (Windows: with PATHEXT). */
export async function findProgram(name: string, platform: Platform, env: Record<string, string | undefined>, isFile: IsFile = isFileOnDisk): Promise<string | undefined> {
  const p = platform === 'win32' ? path.win32 : path.posix;
  if (p.isAbsolute(name) || /[\\/]/.test(name)) {
    const full = p.resolve(name);
    return (await isFile(full)) ? full : undefined;
  }
  const dirs = (env.PATH ?? env.Path ?? '').split(platform === 'win32' ? ';' : ':').filter(Boolean);
  const exts = platform === 'win32' ? ['', ...(env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)] : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = p.join(dir, `${name}${ext}`);
      if (await isFile(candidate)) return candidate;
    }
  }
  return undefined;
}

/** The engine's commands: the custom engine's (CoreEngineConfig.commandRun), else a bare template (EngineConfig.command). */
export function commandRunOf(cfg: CoreEngineConfig | undefined): CommandRun | undefined {
  if (cfg?.commandRun) return cfg.commandRun;
  if (!cfg?.command) return undefined;
  return { mode: 'command', template: cfg.command, api: cfg.flavor === 'openai-chat' ? 'chat' : 'completions' };
}

/** What the placeholders stand for in this launch: the model, where to answer, the settings (unset ones: their defaults). */
export function commandValues(
  model: ModelTarget,
  params: LaunchParams,
  opts: Pick<PlanOptions, 'port' | 'marker' | 'apiName' | 'preview'>,
  run: Pick<CommandRun, 'kvTypes'> = {},
): Record<CommandPlaceholder, string> {
  const local = model.local;
  const main = weightFiles(model, opts.preview).files[0];
  // GGUF: the file; a safetensors folder: the folder; nothing local: the HF repo.
  const modelRef = local?.identity.format === 'safetensors' ? local.dir : (main ?? model.repo ?? model.identity.repo ?? model.identity.displayName);
  const modelDir = local?.dir ?? (main !== undefined ? path.dirname(main) : '');
  return {
    model: modelRef,
    modelDir,
    port: String(opts.port),
    host: LOOPBACK,
    alias: opts.apiName ?? opts.marker,
    ...commandSettingValues(run, params),
  };
}

/** Why a start failed, from the program's own lines: a missing program, a busy port, GPU memory, else the exit. */
export function diagnoseCommand(lines: readonly string[], exit: ExitInfo): AppError {
  const tail = lines.slice(-40).join('\n');
  const code = String(exit.code ?? exit.signal);
  const has = (re: RegExp) => lines.some((l) => re.test(l));
  if (has(/^Error: spawn .*\b(ENOENT|EACCES|EPERM|EINVAL|UNKNOWN)\b/)) return new AppError('ENGINE_START_FAILED', 'The program could not be started', { params: { code }, detail: tail });
  if (has(/address already in use|\[Errno 98\]|EADDRINUSE/i)) return new AppError('ENGINE_PORT_IN_USE', 'The port is already in use', { params: { code }, detail: tail });
  if (has(/CUDA out of memory|OutOfMemoryError|cudaMalloc failed|out of memory/i)) return new AppError('ENGINE_OOM', 'Out of GPU memory', { params: { code }, detail: tail });
  return new AppError('ENGINE_EXITED', `The program exited with ${code}`, { params: { code }, detail: tail });
}

/** The programs of every command, found on disk: the ones before the server, the server's, the ones after. */
export interface CommandPrograms {
  before: string[];
  server: string;
  after: string[];
}

/** Where a command is among the engine's: undefined for the server, else before/after and its number. */
type StepRef = { which: 'before' | 'after'; n: number } | undefined;

export class CommandAdapter implements EngineAdapter {
  readonly kind = 'command' as const;

  constructor(private readonly o: CommandAdapterOptions) {}

  /** A command's program as a file; a command that cannot be used, or a program not found, throws (naming the command). */
  private async programOf(line: string, step: StepRef): Promise<string> {
    const where: Record<string, string | number> = step ? { which: step.which, n: step.n } : {};
    const problem = templateProblem(line, { server: step === undefined });
    if (problem !== undefined) throw new AppError('VALIDATION', `Command template: ${problem}`, { params: { reason: problem, ...where } });
    const name = (splitCommandLine(line) as string[])[0] as string;
    const { platform, env } = this.o.deps;
    const found = await findProgram(name, platform, env, this.o.isFile);
    if (!found) throw new AppError('ENGINE_NOT_INSTALLED', `Program not found: ${name}`, { params: { path: name, reason: 'program_missing', ...where } });
    // Without a shell a .bat/.cmd cannot start: the command says `cmd /c script.bat …` instead.
    if (platform === 'win32' && /\.(bat|cmd)$/i.test(found)) {
      throw new AppError('VALIDATION', 'Batch files need cmd /c', { params: { reason: 'command_batch', path: found, ...where } });
    }
    return found;
  }

  /** Every command's program, in the order they run; the first that cannot be used throws. */
  async programs(cfg: CoreEngineConfig | undefined): Promise<CommandPrograms> {
    const run = commandRunOf(cfg);
    if (!run) throw new AppError('ENGINE_NOT_INSTALLED', 'No command template', { params: { reason: 'command_missing' } });
    const before: string[] = [];
    const steps = commandStepsOf(run);
    for (const [i, line] of steps.before.entries()) before.push(await this.programOf(line, { which: 'before', n: i + 1 }));
    const server = await this.programOf(run.template, undefined);
    const after: string[] = [];
    for (const [i, line] of steps.after.entries()) after.push(await this.programOf(line, { which: 'after', n: i + 1 }));
    return { before, server, after };
  }

  async detect(cfg?: CoreEngineConfig): Promise<EngineStatus> {
    try {
      const { server } = await this.programs(cfg);
      return { kind: this.kind, available: true, installed: true, location: server, variant: 'openai', problems: [], supported: true };
    } catch (e) {
      // programs() only throws AppErrors that say why (reason, path, which command).
      const err = toAppErrorData(e);
      return { kind: this.kind, available: false, installed: false, problems: [err.code], problemParams: err.params as NonNullable<typeof err.params>, supported: true };
    }
  }

  /** Nothing known about the program: text prompts, the counts its usage reports; the settings its commands take. */
  capabilities(cfg?: CoreEngineConfig): Promise<EngineCaps> {
    const run = commandRunOf(cfg);
    const caps: EngineCaps = { flags: new Set<string>(), tokenIdsInPrompt: false, timings: false, minTokens: false, fitFlag: false, variant: 'openai' };
    if (run) caps.command = { settings: commandSettings(run), kvTypes: commandKvTypes(run) };
    return Promise.resolve(caps);
  }

  async plan(cfg: CoreEngineConfig, model: ModelTarget, params: LaunchParams, opts: PlanOptions): Promise<LaunchPlan> {
    const programs = await this.programs(cfg);
    const run = commandRunOf(cfg) as CommandRun;
    const values = commandValues(model, params, opts, run);
    // The program found on disk replaces the name written; the arguments are filled one by one.
    const fill = (line: string, program: string) => [program, ...expandCommandTemplate(line, values).slice(1)];
    const files = weightFiles(model, opts.preview).files;
    const sizes = await Promise.all(files.map((f) => fs.stat(f).then((s) => s.size, () => 0)));
    const bytes = sizes.reduce((a, b) => a + b, 0);
    // The API it is measured with: /v1/completions, or chat completions for servers without it.
    const variant = cfg.flavor === 'openai-chat' ? 'openai-chat' : 'openai';
    const engine: EngineIdentity = { kind: this.kind, name: 'OpenAI server', variant, executable: programs.server };
    const { before, after } = commandStepsOf(run);
    const hasSteps = before.length > 0 || after.length > 0;
    return {
      kind: this.kind,
      argv: [...fill(run.template, programs.server), ...params.extraArgs],
      env: { ...params.env },
      host: LOOPBACK,
      port: opts.port,
      params: commandParams(run, params),
      engine,
      modelFiles: files,
      modelBytes: bytes > 0 ? bytes : (model.identity.sizeBytes ?? 0),
      marker: opts.marker,
      ...(hasSteps
        ? { steps: { before: before.map((l, i) => fill(l, programs.before[i] as string)), after: after.map((l, i) => fill(l, programs.after[i] as string)) } }
        : {}),
    };
  }

  start(plan: LaunchPlan, signal: AbortSignal): Promise<EngineInstance> {
    if (signal.aborted) return Promise.reject(new AppError('CANCELLED', 'Engine start cancelled'));
    const steps = plan.steps;
    if (!steps) return this.startServer(plan, signal);
    const flavor = plan.engine.variant === 'openai-chat' ? 'openai-chat' : 'openai';
    return Promise.resolve(
      createSteppedInstance({
        plan,
        steps,
        signal,
        deps: this.o.deps,
        startServer: (s) => this.startServer(plan, s),
        idleClient: this.o.createClient(flavor, `http://${plan.host}:${plan.port}`),
        ...(this.o.beforeTimeoutMs !== undefined ? { beforeTimeoutMs: this.o.beforeTimeoutMs } : {}),
        ...(this.o.afterTimeoutMs !== undefined ? { afterTimeoutMs: this.o.afterTimeoutMs } : {}),
      }),
    );
  }

  /** The server itself: started, recorded as ours, polled until it lists its name (or any, without {alias}). */
  private async startServer(plan: LaunchPlan, signal: AbortSignal): Promise<EngineInstance> {
    // A cancelled start never gets here from start(); after commands before, the readiness wait below stops it at once.
    const [cmd, ...args] = plan.argv as [string, ...string[]];
    const { clock, proc, log, fetch } = this.o.deps;
    let mp: ManagedProcess;
    try {
      mp = proc.spawn({ cmd, args, env: plan.env, owner: { runId: plan.marker, marker: plan.marker } });
    } catch (e) {
      throw new AppError('ENGINE_START_FAILED', `Cannot start ${cmd}: ${String(e)}`, { cause: e });
    }
    const ownership = this.o.ownership;
    if (ownership && mp.pid > 0) {
      const rec: OwnedRecord = { pid: mp.pid, startedAtWall: clock.wall(), exe: cmd, marker: plan.marker, runId: plan.marker, kind: 'process' };
      await ownership.add(rec).catch((e: unknown) => log.warn('ownership record failed', { error: String(e) }));
    }
    const baseUrl = `http://${plan.host}:${plan.port}`;
    // The name it serves: ours when the template passes {alias}, else whatever it lists first.
    const named = plan.argv.some((a) => a.includes(plan.marker)) ? plan.marker : undefined;
    const flavor = plan.engine.variant === 'openai-chat' ? 'openai-chat' : 'openai';
    // Reasoning switched off: its chat requests ask the template not to think (engines/shared/reasoning-vision.ts).
    const kwargs = chatKwargsOf(flavor, plan.params);
    let client: InferenceClient = this.o.createClient(flavor, baseUrl, { ...(named ? { model: named } : {}), ...kwargs });
    const inst = createProcessInstance({
      mp,
      baseUrl,
      client,
      clock,
      probe: async (s) => {
        const t = AbortSignal.any([s, AbortSignal.timeout(PROBE_TIMEOUT_MS)]);
        const res = await fetch(`${baseUrl}/v1/models`, { signal: t });
        const body = await res.text();
        return res.ok && (named === undefined || listsModel(body, named));
      },
      phaseOf: () => undefined,
      diagnose: diagnoseCommand,
      startSignal: signal,
      ...(this.o.pollMs !== undefined ? { pollMs: this.o.pollMs } : {}),
      ...(this.o.readyTimeoutMs !== undefined ? { readyTimeoutMs: this.o.readyTimeoutMs } : {}),
      ...(ownership ? { onExit: () => ownership.remove(mp.pid) } : {}),
    });
    return {
      ...inst,
      get client() {
        return client;
      },
      waitReady: async (s) => {
        const ready = await inst.waitReady(s);
        if (named === undefined) {
          const ids = await client.models(s).catch(() => []);
          if (ids[0] !== undefined) client = this.o.createClient(flavor, baseUrl, { model: ids[0], ...kwargs });
        }
        return ready;
      },
    };
  }
}
