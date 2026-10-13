/**
 * "Programma con API OpenAI" (kind 'command'): any program that serves the OpenAI API, started from
 * the user's command template (contract/custom-engines.ts). GPU Bench fills in the placeholders,
 * starts it, waits for /v1/models, measures it like an external endpoint (text prompts, usage
 * counts) and stops it. Only the process it started is ever stopped: it is recorded in the
 * ownership registry like every engine process, and verified by the marker in its command line
 * after a crash ({alias}); without {alias} a leftover is left alone rather than guessed at.
 *
 * Nothing runs to check the program (a `--version` could start a server): the template is
 * validated and the program looked up on disk or on PATH.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { expandCommandTemplate, splitCommandLine, templateProblem, type CommandPlaceholder } from '../../../contract/custom-engines';
import type { EngineConfig, EngineStatus, LaunchParams } from '../../../contract/engines';
import { AppError, toAppErrorData } from '../../../contract/errors';
import type { EngineIdentity } from '../../../contract/results';
import type { CoreDeps, ExitInfo, ManagedProcess, Platform } from '../../deps';
import type { InferenceClient } from '../../inference/types';
import type { OwnershipRegistry } from '../../process/ownership';
import { LOOPBACK } from '../../process/ports';
import { createProcessInstance, type ClientFactory } from '../instance';
import { listsModel } from '../shared/probes';
import type { EngineAdapter, EngineCaps, EngineInstance, LaunchPlan, ModelTarget, PlanOptions } from '../types';
import { weightFiles } from '../types';

export type CommandDeps = Pick<CoreDeps, 'clock' | 'proc' | 'fetch' | 'platform' | 'log' | 'env'>;

export interface CommandAdapterOptions {
  deps: CommandDeps;
  createClient: ClientFactory;
  ownership?: Pick<OwnershipRegistry, 'add' | 'remove'>;
  readyTimeoutMs?: number;
  pollMs?: number;
}

/** Context passed as {ctx} when the run sets none. */
export const COMMAND_DEFAULT_CONTEXT = 4096;
const PROBE_TIMEOUT_MS = 5000;

/** `name` as a file: a path (relative to the working folder) or a name found on PATH (Windows: with PATHEXT). */
export async function findProgram(name: string, platform: Platform, env: Record<string, string | undefined>): Promise<string | undefined> {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const isFile = async (f: string) => (await fs.stat(f).catch(() => undefined))?.isFile() === true;
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

/** What the placeholders stand for in this launch. */
export function commandValues(model: ModelTarget, params: LaunchParams, opts: Pick<PlanOptions, 'port' | 'marker' | 'apiName' | 'preview'>): Record<CommandPlaceholder, string> {
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
    ctx: String(params.contextSize ?? params.maxModelLen ?? COMMAND_DEFAULT_CONTEXT),
    alias: opts.apiName ?? opts.marker,
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

export class CommandAdapter implements EngineAdapter {
  readonly kind = 'command' as const;

  constructor(private readonly o: CommandAdapterOptions) {}

  /** The template's program as a file; a template that cannot be used, or a program not found, throws. */
  async program(cfg: EngineConfig | undefined): Promise<string> {
    const template = cfg?.command;
    if (!template) throw new AppError('ENGINE_NOT_INSTALLED', 'No command template', { params: { reason: 'command_missing' } });
    const problem = templateProblem(template);
    if (problem !== undefined) throw new AppError('VALIDATION', `Command template: ${problem}`, { params: { reason: problem } });
    const name = (splitCommandLine(template) as string[])[0] as string;
    const { platform, env } = this.o.deps;
    const found = await findProgram(name, platform, env);
    if (!found) throw new AppError('ENGINE_NOT_INSTALLED', `Program not found: ${name}`, { params: { path: name, reason: 'program_missing' } });
    // Without a shell a .bat/.cmd cannot start: the template says `cmd /c script.bat …` instead.
    if (platform === 'win32' && /\.(bat|cmd)$/i.test(found)) {
      throw new AppError('VALIDATION', 'Batch files need cmd /c', { params: { reason: 'command_batch', path: found } });
    }
    return found;
  }

  async detect(cfg?: EngineConfig): Promise<EngineStatus> {
    try {
      const program = await this.program(cfg);
      return { kind: this.kind, available: true, installed: true, location: program, variant: 'openai', problems: [], supported: true };
    } catch (e) {
      const err = toAppErrorData(e);
      return { kind: this.kind, available: false, installed: false, problems: [err.code], ...(err.params ? { problemParams: err.params } : {}), supported: true };
    }
  }

  /** Nothing known about the program: text prompts, the counts its usage reports. */
  capabilities(): Promise<EngineCaps> {
    return Promise.resolve({ flags: new Set<string>(), tokenIdsInPrompt: false, timings: false, minTokens: false, fitFlag: false, variant: 'openai' });
  }

  async plan(cfg: EngineConfig, model: ModelTarget, params: LaunchParams, opts: PlanOptions): Promise<LaunchPlan> {
    const program = await this.program(cfg);
    const template = cfg.command as string;
    const [, ...rest] = expandCommandTemplate(template, commandValues(model, params, opts));
    const files = weightFiles(model, opts.preview).files;
    const sizes = await Promise.all(files.map((f) => fs.stat(f).then((s) => s.size, () => 0)));
    const bytes = sizes.reduce((a, b) => a + b, 0);
    const engine: EngineIdentity = { kind: this.kind, name: 'OpenAI server', variant: 'openai', executable: program };
    return {
      kind: this.kind,
      argv: [program, ...rest, ...params.extraArgs],
      env: { ...params.env },
      host: LOOPBACK,
      port: opts.port,
      params,
      engine,
      modelFiles: files,
      modelBytes: bytes > 0 ? bytes : (model.identity.sizeBytes ?? 0),
      marker: opts.marker,
    };
  }

  async start(plan: LaunchPlan, signal: AbortSignal): Promise<EngineInstance> {
    if (signal.aborted) throw new AppError('CANCELLED', 'Engine start cancelled');
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
      const rec = { pid: mp.pid, startedAtWall: clock.wall(), exe: cmd, marker: plan.marker, runId: plan.marker, kind: 'process' as const };
      await ownership.add(rec).catch((e: unknown) => log.warn('ownership record failed', { error: String(e) }));
    }
    const baseUrl = `http://${plan.host}:${plan.port}`;
    // The name it serves: ours when the template passes {alias}, else whatever it lists first.
    const named = plan.argv.some((a) => a.includes(plan.marker)) ? plan.marker : undefined;
    let client: InferenceClient = this.o.createClient('openai', baseUrl, named ? { model: named } : {});
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
          if (ids[0] !== undefined) client = this.o.createClient('openai', baseUrl, { model: ids[0] });
        }
        return ready;
      },
    };
  }
}

