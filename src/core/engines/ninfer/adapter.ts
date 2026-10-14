/**
 * NInfer (contract/ninfer.ts): ninfer-serve from the user's own build (or LLM Bench's guided build),
 * on Linux ('ninfer-native') or inside a WSL distro on Windows ('ninfer-wsl', see wsl.ts).
 *
 *  - detect: where the build is (the request's config, else settings.ninfer); one probe runs
 *    `ninfer-serve --help` (its options must be NInfer's) and reads the checkout's commit
 *    (`git rev-parse`, else a ninfer-commit.txt next to it); cached per build. Nothing is probed until
 *    the user says where NInfer is, so WSL is not even started otherwise. The GPU must be an RTX 5090.
 *  - plan: the exact argv (args.ts); the artifact as the engine sees it (WSL: /mnt/<drive>/… for a
 *    Windows file, flagged slow; the distro's own path for \\wsl.localhost\<distro>\…).
 *  - start: readiness = /health 200 and /v1/models listing our --model-id; the chat client measures it.
 *    Native: an engine process of ours like llama-server (ownership registry). WSL: our Linux PID and
 *    marker are recorded and checked before any signal (wsl.ts).
 */
import { promises as fs } from 'node:fs';
import type { EngineConfig, EngineStatus, LaunchParams } from '../../../contract/engines';
import { AppError, toAppErrorData } from '../../../contract/errors';
import { NINFER_FILE, NINFER_MANIFEST, ninferManifestFromName, parseNinferManifest, type NinferManifest } from '../../../contract/formats';
import { NINFER_BUILT_COMMIT_FILE, ninferGpuSupported, ninferMemory, NINFER_SERVE_PATH, ninferServeOf, type NinferKind, type NinferSettings } from '../../../contract/ninfer';
import { readNinferHeader } from '../../models/ninfer-header';
import type { EngineIdentity } from '../../../contract/results';
import type { EvictResult } from '../../cache/evictor';
import { createLinuxEvictor } from '../../cache/evictor';
import type { CoreDeps, LogLine, ManagedProcess, RunOutput } from '../../deps';
import type { OwnershipRegistry } from '../../process/ownership';
import { AsyncQueue } from '../../process/runner';
import { LOOPBACK } from '../../process/ports';
import { readJsonFile } from '../../store/atomic';
import { createProcessInstance, type ClientFactory } from '../instance';
import { modelReadyProbe } from '../shared/probes';
import { trustedFlags } from '../shared/standard-flags';
import type { EngineAdapter, EngineCaps, EngineInstance, LaunchPlan, ModelTarget, PlanOptions } from '../types';
import { ninferServeArgs } from './args';
import { diagnoseNinfer, ninferMessage, PID_LINE } from './logs';
import { distroRunner, hostArgv, wslLaunchArgv, wslPathOf, type DistroRun, type WslProcesses } from './wsl';

export type NinferDeps = Pick<CoreDeps, 'clock' | 'proc' | 'fetch' | 'platform' | 'log'>;

/** A GPU as the telemetry probe reports it. */
export interface GpuFacts {
  name?: string;
  computeCapability?: string;
  memTotalMiB?: number | null;
}

export interface NinferAdapterOptions {
  kind: NinferKind;
  deps: NinferDeps;
  createClient: ClientFactory;
  /** Where the build is when the request does not say (settings.ninfer). */
  saved: () => Promise<NinferSettings | undefined>;
  /** The GPUs of this PC (NInfer runs on an RTX 5090 only). */
  gpus: () => Promise<GpuFacts[]>;
  /** Native: engine processes are recorded like llama-server's. */
  ownership?: Pick<OwnershipRegistry, 'add' | 'remove'>;
  /** WSL: wsl.exe (an argv prefix: tests use a fake) and the record of our processes in the distros. */
  wsl?: { argv: readonly string[]; processes: WslProcesses };
  /** Native, tests only: argv placed before ninfer-serve and the checks of a build (a fake Linux host through node). */
  launcherPrefix?: string[];
  readyTimeoutMs?: number;
  pollMs?: number;
  /** How long a probe of a build is trusted (default 5 min; "Ricontrolla" asks again). */
  probeTtlMs?: number;
}

/** Where a launch finds NInfer. */
export interface NinferWhere {
  /** ninfer-serve, a Linux path. */
  serve: string;
  /** The checkout (for its commit), when the path is one or ends in build/apps/ninfer-serve. */
  repo?: string;
  /** ninfer-wsl: the distro. */
  distro?: string;
}

/** What one probe of a build found. */
export interface NinferProbe {
  ok: boolean;
  flags: Set<string>;
  /** The program's full path ("~/" expanded to the home there). */
  at?: string;
  /** Its build string (`ninfer-serve --version`, when its help lists it: NInfer-all "0.12.0-rtx3090+v0.6.0-rtx3090-1704-ge7b7e669"). */
  release?: string;
  /** The --kv-dtype values its help lists (official: bf16 int8 fp8 nvfp4 k8v4; NInfer-all adds rk8v4…); absent = not said. */
  kvDtypes?: string[];
  /** Full commit hash of the checkout, when known. */
  commit?: string;
  /** The commit its program was built from (build/.llmbench-built-commit, written by LLM Bench's builds). */
  built?: string;
  /** When the checkout's last commit was made, and when its program was written (seconds since 1970). */
  headTime?: number;
  serveTime?: number;
  /** Why it cannot be used (ENGINE_NOT_INSTALLED with a reason). */
  error?: AppError;
}

/**
 * The program is older than its checkout's code ("Da ricompilare"): built from another commit than the
 * one checked out, or (built by hand: no record) written before the last commit was made.
 */
export function probeStale(p: Pick<NinferProbe, 'ok' | 'commit' | 'built' | 'headTime' | 'serveTime'>): boolean {
  if (!p.ok || p.commit === undefined) return false;
  if (p.built !== undefined) return p.built !== p.commit;
  return p.headTime !== undefined && p.serveTime !== undefined && p.headTime > p.serveTime;
}

/**
 * The --kv-dtype values a help lists, in its order. The official build prints them in its usage line
 * ("[--kv-dtype bf16|int8|fp8|nvfp4|k8v4]"), NInfer-all in an option table over two lines ("--kv-dtype T
 * KV storage: bf16 (default), int8, fp8, rk8v4,\n rk4v4, rk4v4-e8, rk2v4-e8, nvfp4 or k8v4"): the words
 * after the flag up to the next option, those with a digit in them (a type name always has its bits).
 */
export function kvDtypesOfHelp(help: string): string[] | undefined {
  const at = help.search(/--kv-dtype\b/);
  if (at < 0) return undefined;
  const rest = help.slice(at + '--kv-dtype'.length);
  const end = rest.search(/(?:^|[\s[])--[a-z]/m);
  const words = (end < 0 ? rest : rest.slice(0, end)).split(/[\s|,[\]()]+/).filter((w) => /^[a-z0-9][a-z0-9_-]*$/.test(w) && /\d/.test(w));
  return words.length ? [...new Set(words)] : undefined;
}

/** A plan that also says how to reach the process later (start, stop, eviction). */
export interface NinferLaunchPlan extends LaunchPlan {
  ninfer: { distro?: string; kvTokens?: number; bytesPerToken?: number; build?: string };
  /** The model is read through 9p (/mnt/<drive>): loads are much slower (validity 'slow_shared_filesystem'). */
  slowSharedFilesystem?: boolean;
}

/**
 * Probe script: the help (its exit code after it), the checkout's commit, the commit its program was
 * built from (LLM Bench's record), when the last commit was made and when the program was written.
 */
export const PROBE_SCRIPT = [
  'serve="$1"; repo="$2"',
  // "~/…" (NInfer-all's usual folder before it is saved) is the user's home there.
  'case "$serve" in "~/"*) serve="$HOME/${serve#"~/"}";; esac',
  'case "$repo" in "~/"*) repo="$HOME/${repo#"~/"}";; esac',
  'h=$("$serve" --help 2>&1); rc=$?',
  'printf "%s\\n" "$h"',
  'echo "##gpubench-help $rc"',
  'echo "##gpubench-at $serve"',
  // Its build string ("0.12.0-rtx3090+v0.6.0-rtx3090-1704-ge7b7e669"), from a build whose help lists --version (NInfer-all).
  'case "$h" in *--version*) echo "##gpubench-release $("$serve" --version 2>&1 | head -n 1)";; esac',
  'if [ -n "$repo" ]; then',
  '  c=$(git -C "$repo" rev-parse HEAD 2>/dev/null) || c=$(cat "$repo/ninfer-commit.txt" "$repo/../ninfer-commit.txt" 2>/dev/null | head -n 1)',
  '  echo "##gpubench-commit $c"',
  `  echo "##gpubench-built $(head -n 1 "$repo/${NINFER_BUILT_COMMIT_FILE}" 2>/dev/null)"`,
  '  echo "##gpubench-headtime $(git -C "$repo" log -1 --format=%ct HEAD 2>/dev/null)"',
  'fi',
  'echo "##gpubench-servetime $(stat -c %Y "$serve" 2>/dev/null)"',
].join('\n');

const notInstalled = (reason: string, params: Record<string, string> = {}) =>
  new AppError('ENGINE_NOT_INSTALLED', `NInfer: ${reason}`, { params: { reason, kind: 'ninfer', ...params } });

/** The probe's output: help text and exit code, the commit. */
export function parseProbe(out: RunOutput, where: NinferWhere): NinferProbe {
  const text = `${out.stdout}\n${out.stderr}`.replace(/\0/g, '');
  const help = /##gpubench-help (\d+)/.exec(text);
  if (!help) {
    if (out.code === null) return { ok: false, flags: new Set(), error: notInstalled('wsl_missing') };
    if (/There is no distribution|WSL_E_DISTRO_NOT_FOUND|distribuzione con il nome/i.test(text)) return { ok: false, flags: new Set(), error: notInstalled('distro_missing', where.distro ? { distro: where.distro } : {}) };
    return { ok: false, flags: new Set(), error: notInstalled('ninfer_not_found', { path: where.serve }) };
  }
  const helpText = text.slice(0, help.index);
  const flags = new Set(helpText.match(/--[a-z][a-z0-9-]*/g) ?? []);
  const commit = /##gpubench-commit ([0-9a-f]{7,40})/.exec(text)?.[1];
  const built = /##gpubench-built ([0-9a-f]{7,40})/.exec(text)?.[1];
  const time = (key: string) => Number(new RegExp(`##gpubench-${key} (\\d+)`).exec(text)?.[1]) || undefined;
  const headTime = time('headtime');
  const serveTime = time('servetime');
  const at = /##gpubench-at (\/[^\r\n]*)/.exec(text)?.[1];
  // "ninfer-serve 0.12.0-rtx3090+v0.6.0-…" → the version itself.
  const release = /##gpubench-release[^\d\r\n]*(\d+\.\d+[\w.+-]*)/.exec(text)?.[1];
  const ours = help[1] === '0' && trustedFlags('ninfer', flags) !== undefined && flags.has('--kv-dtype');
  const kvDtypes = ours ? kvDtypesOfHelp(helpText) : undefined;
  return {
    ok: ours,
    flags,
    ...(at ? { at } : {}),
    ...(release ? { release } : {}),
    ...(kvDtypes ? { kvDtypes } : {}),
    ...(commit ? { commit } : {}),
    ...(built ? { built } : {}),
    ...(headTime ? { headTime } : {}),
    ...(serveTime ? { serveTime } : {}),
    ...(ours ? {} : { error: notInstalled('ninfer_not_found', { path: where.serve }) }),
  };
}

/** A build's identity: its commit (what "the same build" compares) and its version in words (its --version, else the commit). */
export function buildIdOf(probe: Pick<NinferProbe, 'commit' | 'release'> | undefined): { version?: string; build?: string } {
  const commit = probe?.commit?.slice(0, 12);
  const version = probe?.release ?? commit;
  return { ...(version ? { version } : {}), ...(commit ? { build: commit } : {}) };
}

/** ninfer-serve of a path: the program itself, or a checkout / build folder holding it (contract/ninfer.ts, the card reads it too). */
export const serveOf = ninferServeOf;

/** The .ninfer artifact of a model, and its manifest next to it (when the library found one). */
export function artifactOf(model: ModelTarget): { file: string; manifest?: string } {
  const local = model.local;
  const file = local?.paths.find((p) => NINFER_FILE.test(p));
  if (!local || local.identity.format !== 'ninfer' || !file) {
    throw new AppError('VALIDATION', 'NInfer reads .ninfer artifacts only', { params: { reason: 'ninfer_format', model: model.identity.displayName } });
  }
  const manifest = local.paths.find((p) => NINFER_MANIFEST.test(p));
  return { file, ...(manifest ? { manifest } : {}) };
}

/** The manifest a .ninfer file carries at its start, as the sidecar manifest's fields (name, parts, container version). */
export async function embeddedManifest(file: string): Promise<NinferManifest | undefined> {
  const h = await readNinferHeader(file);
  return h ? { ...(h.name ? { name: h.name } : {}), components: h.components, containerVersion: h.containerVersion, proposalHead: h.proposalHead } : undefined;
}

/**
 * The artifact's size and manifest: what the VRAM estimate and the tuner's choices are made from. The
 * manifest next to the file, else the one at its start; without either ("senza manifest"), what the
 * file name says (an "MTP" in it: the MTP head).
 */
export async function ninferArtifactInfo(model: ModelTarget): Promise<{ bytes: number; manifest: NinferManifest; label: string; noManifest?: true }> {
  const { file, manifest } = artifactOf(model);
  const bytes = await fs.stat(file).then((s) => s.size, () => model.identity.sizeBytes ?? 0);
  const parsed = (manifest ? await readJsonFile(manifest).then(parseNinferManifest, () => undefined) : undefined) ?? (await embeddedManifest(file));
  return { bytes, label: model.identity.displayName, ...(parsed ? { manifest: parsed } : { manifest: ninferManifestFromName(file), noManifest: true as const }) };
}

export class NinferAdapter implements EngineAdapter {
  readonly kind: NinferKind;
  private readonly probes = new Map<string, { at: number; result: Promise<NinferProbe> }>();
  private readonly manifests = new Map<string, Promise<NinferManifest | undefined>>();

  constructor(private readonly o: NinferAdapterOptions) {
    this.kind = o.kind;
  }

  private get wsl(): boolean {
    return this.kind === 'ninfer-wsl';
  }

  private supported(): boolean {
    return this.o.deps.platform === (this.wsl ? 'win32' : 'linux');
  }

  /** Where NInfer is for this config: the config's path and distro, else the saved ones. */
  async where(cfg?: EngineConfig): Promise<NinferWhere | undefined> {
    const saved = await this.o.saved().catch(() => undefined);
    const own = this.wsl ? saved?.wsl : saved?.native;
    const p = cfg?.ninferPath ?? own?.path;
    if (!p) return undefined;
    const distro = this.wsl ? (cfg?.wslDistro ?? saved?.wsl?.distro) : undefined;
    return { ...serveOf(p), ...(distro ? { distro } : {}) };
  }

  /** Runs a program where NInfer runs: the distro (WSL) or this system. */
  private runner(where: Pick<NinferWhere, 'distro'>): DistroRun {
    if (this.wsl) return distroRunner(this.o.deps.proc, (this.o.wsl as NonNullable<NinferAdapterOptions['wsl']>).argv, where.distro as string);
    const prefix = this.o.launcherPrefix ?? [];
    return (cmd, args, opts) => this.o.deps.proc.run(...hostArgv(prefix, [cmd, ...args]), opts);
  }

  /** Every build is asked again at its next probe (after an update: its commit changed). */
  forget(): void {
    this.probes.clear();
  }

  /** The build's help and commit, cached per build for probeTtlMs; `fresh` asks again ("Ricontrolla"). */
  probe(where: NinferWhere, fresh = false): Promise<NinferProbe> {
    const key = `${where.distro ?? ''}|${where.serve}`;
    const now = this.o.deps.clock.now();
    const hit = this.probes.get(key);
    if (hit && !fresh && now - hit.at < (this.o.probeTtlMs ?? 5 * 60_000)) return hit.result;
    const result = this.runner(where)('/bin/sh', ['-c', PROBE_SCRIPT, 'sh', where.serve, where.repo ?? ''], { timeoutMs: 60_000 }).then(
      (out) => parseProbe(out, where),
      (e: unknown) => ({ ok: false, flags: new Set<string>(), error: notInstalled('ninfer_not_found', { path: where.serve, detail: String(e) }) }),
    );
    this.probes.set(key, { at: now, result });
    return result;
  }

  /** The RTX 5090 check; undefined when the GPUs cannot be read (never blocks on a probe failure). */
  private async gpuOk(): Promise<boolean | undefined> {
    const gpus = await this.o.gpus().catch(() => []);
    if (gpus.length === 0) return undefined;
    return gpus.some((g) => ninferGpuSupported(g));
  }

  async detect(cfg?: EngineConfig, opts: { fresh?: boolean } = {}): Promise<EngineStatus> {
    if (!this.supported()) return { kind: this.kind, available: false, installed: false, problems: [], supported: false };
    const gpu = await this.gpuOk();
    const gpuProblem = gpu === false ? { problems: ['ENGINE_GPU_UNSUPPORTED'], problemParams: { engine: 'NInfer', gpu: 'RTX 5090' } } : undefined;
    const where = await this.where(cfg);
    if (!where) return { kind: this.kind, available: false, installed: false, ...(gpuProblem ?? { problems: ['ENGINE_NOT_INSTALLED'], problemParams: { reason: 'not_configured' } }), supported: true };
    if (this.wsl && !where.distro) return { kind: this.kind, available: false, installed: false, problems: ['ENGINE_NOT_INSTALLED'], problemParams: { reason: 'distro_missing' }, supported: true };
    const probe = await this.probe(where, opts.fresh);
    const status: EngineStatus = {
      kind: this.kind,
      available: probe.ok && gpu !== false,
      installed: probe.ok,
      location: where.serve,
      ...(where.distro ? { variant: where.distro } : {}),
      ...(probe.commit ? { version: probe.commit.slice(0, 12) } : {}),
      problems: [],
      supported: true,
    };
    if (!probe.ok) {
      // A failed probe always says why (notInstalled: a reason and its details).
      const e = probe.error as AppError;
      return { ...status, problems: [e.code], problemParams: e.params as Record<string, string | number | boolean> };
    }
    return gpuProblem ? { ...status, ...gpuProblem } : status;
  }

  async capabilities(cfg: EngineConfig): Promise<EngineCaps> {
    const where = await this.where(cfg);
    const probe = where ? await this.probe(where) : undefined;
    return {
      ...buildIdOf(probe),
      flags: probe?.flags ?? new Set(),
      // The KV types this build takes: the tuner's ladder and the check of a launch's --kv-dtype.
      ...(probe?.kvDtypes ? { choices: { '--kv-dtype': probe.kvDtypes } } : {}),
      tokenIdsInPrompt: false,
      // NInfer adds llama.cpp-style timings to the last chunk of every Chat Completions stream.
      timings: true,
      minTokens: false,
      fitFlag: false,
    };
  }

  /** The artifact's manifest (name, components), read once per file. */
  manifestOf(file: string | undefined): Promise<NinferManifest | undefined> {
    if (!file) return Promise.resolve(undefined);
    return this.once(`json:${file}`, () => readJsonFile(file).then(parseNinferManifest, () => undefined));
  }

  /** The manifest at the start of the .ninfer file itself, read once per file. */
  embeddedOf(file: string): Promise<NinferManifest | undefined> {
    return this.once(`ninfer:${file}`, () => embeddedManifest(file));
  }

  private once(key: string, read: () => Promise<NinferManifest | undefined>): Promise<NinferManifest | undefined> {
    let p = this.manifests.get(key);
    if (!p) {
      p = read();
      this.manifests.set(key, p);
    }
    return p;
  }

  async plan(cfg: EngineConfig, model: ModelTarget, params: LaunchParams, opts: PlanOptions): Promise<NinferLaunchPlan> {
    if (!this.supported()) throw new AppError('ENGINE_NOT_INSTALLED', 'NInfer runs on Linux or in WSL on Windows', { params: { reason: 'unsupported-os', kind: this.kind } });
    const where = await this.where(cfg);
    // A preview names where NInfer will be once the user says (or builds it).
    if (!where && !opts.preview) throw notInstalled('not_configured');
    const serve = where?.serve ?? `~/ninfer/${NINFER_SERVE_PATH}`;
    const distro = where?.distro;
    if (this.wsl && !distro && !opts.preview) throw notInstalled('distro_missing');
    const { file, manifest } = artifactOf(model);
    let modelPath = file;
    let slow = false;
    if (this.wsl) {
      const mapped = wslPathOf(file, distro ?? '');
      if (!mapped) throw new AppError('VALIDATION', 'The model is in another WSL distro or on a network share', { params: { reason: 'ninfer_wsl_path', path: file, distro: distro ?? '' } });
      modelPath = mapped.path;
      slow = mapped.slow;
    }
    // --lm-head-draft requires the optimized proposal head ("selected proposal head is absent from artifact"
    // otherwise); NInfer uses it by itself when the artifact stores one, so it is only left out.
    const noHead = params.ninfer?.lmHeadDraft === true && (await this.embeddedOf(file))?.proposalHead === false;
    const launch = noHead ? { ...params, ninfer: { ...params.ninfer, lmHeadDraft: false } } : params;
    const args = ninferServeArgs(launch, { model: modelPath, host: LOOPBACK, port: opts.port, modelId: opts.apiName ?? opts.marker });
    // probe() never rejects: a build that does not answer is a probe that says so.
    const probe = where ? await this.probe(where) : undefined;
    const commit = probe?.commit?.slice(0, 12);
    // A KV type this build does not list (a variant's rk8v4 on the official NInfer): said before anything starts.
    const kvDtype = params.ninfer?.kvDtype;
    if (kvDtype !== undefined && probe?.kvDtypes && !probe.kvDtypes.includes(kvDtype)) {
      throw new AppError('ENGINE_BAD_FLAG', `This NInfer build does not take --kv-dtype ${kvDtype}`, { params: { flag: '--kv-dtype', value: kvDtype, values: probe.kvDtypes.join(', '), reason: 'kv_dtype_unsupported' } });
    }
    const engine: EngineIdentity = { kind: this.kind, name: 'NInfer', executable: serve, ...buildIdOf(probe), ...(distro ? { variant: distro } : {}) };
    const env = { ...params.env };
    const argv = this.wsl
      ? wslLaunchArgv((this.o.wsl as NonNullable<NinferAdapterOptions['wsl']>).argv, { distro: distro ?? '<distro>', serve, args, env, marker: opts.marker })
      : [...(this.o.launcherPrefix ?? []), serve, ...args];
    const size = await fs.stat(file).then((s) => s.size, () => 0);
    const parts = (await this.manifestOf(manifest)) ?? (await this.embeddedOf(file)) ?? ninferManifestFromName(file);
    const mem = ninferMemory({ artifactBytes: size, manifest: parts, label: model.identity.displayName, params });
    const capacity = params.ninfer?.kvCapacity;
    const kvTokens = typeof capacity === 'number' ? capacity : capacity === undefined ? params.contextSize : undefined;
    return {
      kind: this.kind,
      argv,
      // WSL: the variables go in through `env` inside the distro (Windows' own are not passed on).
      env: this.wsl ? {} : env,
      host: LOOPBACK,
      port: opts.port,
      // What was really launched: a run says no proposal head when the artifact has none.
      params: launch,
      engine,
      // Native: the page cache of this system; WSL: the distro's, evicted from inside it (evict()).
      modelFiles: [this.wsl ? modelPath : file],
      modelBytes: size > 0 ? size : (model.identity.sizeBytes ?? 0),
      marker: opts.marker,
      ninfer: { ...(distro ? { distro } : {}), ...(kvTokens !== undefined ? { kvTokens } : {}), bytesPerToken: mem.bytesPerToken, ...(commit ? { build: commit } : {}) },
      ...(slow ? { slowSharedFilesystem: true } : {}),
      ...(!where ? { pending: ['engine' as const] } : {}),
    };
  }

  /**
   * Cold loads: the artifact's pages are dropped from the page cache that serves it. WSL keeps its own
   * (the distro's kernel): evicted from inside the distro, as on Linux (posix_fadvise, no root).
   */
  async evict(plan: LaunchPlan, signal?: AbortSignal): Promise<EvictResult | undefined> {
    if (!this.wsl) return undefined;
    const distro = (plan as NinferLaunchPlan).ninfer?.distro;
    if (!distro) return { guaranteed: false, reason: 'not-supported' };
    const run = this.runner({ distro });
    const evictor = createLinuxEvictor({ proc: { run, spawn: this.o.deps.proc.spawn } });
    return evictor.evict(plan.modelFiles, signal).catch(() => ({ guaranteed: false, reason: 'failed' as const }));
  }

  async start(plan: LaunchPlan, signal: AbortSignal): Promise<EngineInstance> {
    if (signal.aborted) throw new AppError('CANCELLED', 'Engine start cancelled');
    const p = plan as NinferLaunchPlan;
    const [cmd, ...args] = plan.argv as [string, ...string[]];
    const { clock, proc, log, fetch } = this.o.deps;
    let mp: ManagedProcess;
    try {
      mp = proc.spawn({ cmd, args, env: plan.env, owner: { runId: plan.marker, marker: plan.marker } });
    } catch (e) {
      throw new AppError('ENGINE_START_FAILED', `Cannot start ${cmd}: ${String(e)}`, { cause: e });
    }
    const distro = p.ninfer?.distro;
    let watched = mp;
    let onExit: (() => Promise<void>) | undefined;
    if (this.wsl && distro) {
      const wsl = this.o.wsl as NonNullable<NinferAdapterOptions['wsl']>;
      const linux = { pid: undefined as number | undefined };
      // The launcher's first line is the Linux PID: recorded (crash leftovers), never shown as an engine line.
      const lines = new AsyncQueue<LogLine>();
      void (async () => {
        for await (const line of mp.lines) {
          const pid = PID_LINE.exec(line.text)?.[1];
          if (pid !== undefined && linux.pid === undefined) {
            linux.pid = Number(pid);
            await wsl.processes.add({ distro, pid: linux.pid, marker: plan.marker, startedAtWall: clock.wall() }).catch((e: unknown) => log.warn('ninfer wsl record failed', { error: String(e) }));
            continue;
          }
          lines.push(line);
        }
        lines.close();
      })();
      const stop = async (o?: { graceMs?: number }) => {
        // Our ninfer-serve inside the distro first (checked by its marker), then the wsl.exe relay.
        if (linux.pid !== undefined) await wsl.processes.stop({ distro, pid: linux.pid, marker: plan.marker }, mp.exited).catch((e: unknown) => log.warn('ninfer wsl stop failed', { error: String(e) }));
        return mp.stop(o);
      };
      watched = { pid: mp.pid, startedAt: mp.startedAt, lines, exited: mp.exited, stop };
      onExit = async () => {
        if (linux.pid !== undefined) await wsl.processes.remove(distro, linux.pid);
      };
    } else if (this.o.ownership && mp.pid > 0) {
      const ownership = this.o.ownership;
      const exe = this.o.launcherPrefix?.length ? cmd : await fs.realpath(cmd).catch(() => cmd);
      await ownership.add({ pid: mp.pid, startedAtWall: clock.wall(), exe, marker: plan.marker, runId: plan.marker, kind: 'process' }).catch((e: unknown) => log.warn('ownership record failed', { error: String(e) }));
      onExit = () => ownership.remove(mp.pid);
    }
    const modelId = plan.argv[plan.argv.indexOf('--model-id') + 1] as string;
    const baseUrl = `http://${plan.host}:${plan.port}`;
    const inst = createProcessInstance({
      mp: watched,
      baseUrl,
      client: this.o.createClient('openai-chat', baseUrl, { model: modelId }),
      clock,
      probe: modelReadyProbe(fetch, baseUrl, modelId),
      phaseOf,
      diagnose: (lines, exit) =>
        diagnoseNinfer(lines, exit, {
          ...(p.ninfer?.kvTokens !== undefined ? { kvTokens: p.ninfer.kvTokens } : {}),
          ...(p.ninfer?.bytesPerToken !== undefined ? { bytesPerToken: p.ninfer.bytesPerToken } : {}),
          ...(distro ? { distro } : {}),
          ...(p.ninfer?.build ? { build: p.ninfer.build } : {}),
        }),
      startSignal: signal,
      ...(this.o.pollMs !== undefined ? { pollMs: this.o.pollMs } : {}),
      ...(this.o.readyTimeoutMs !== undefined ? { readyTimeoutMs: this.o.readyTimeoutMs } : {}),
      ...(onExit ? { onExit } : {}),
    });
    if (!this.wsl) return inst;
    // The process LLM Bench sees is wsl.exe: its VRAM is the WSL VM's, never attributable to the engine.
    const { pid: _relay, ...rest } = inst;
    return rest;
  }

  /** The check of the Engines page ("Indica dove si trova", "Ricontrolla"): always a fresh probe. */
  check(cfg: EngineConfig): Promise<EngineStatus> {
    return this.detect(cfg, { fresh: true }).catch((e: unknown) => {
      const err = toAppErrorData(e);
      return { kind: this.kind, available: false, installed: false, problems: [err.code], ...(err.params ? { problemParams: err.params } : {}), supported: true };
    });
  }
}

/** Load phases for the run's timeline: weights, engine ready, listening. */
export function phaseOf(text: string): string | undefined {
  const head = ninferMessage(text).split(' | ')[0];
  if (head === 'weights ready') return 'weights';
  if (head === 'CUDA graphs ready') return 'cuda-graphs';
  if (head === 'engine ready') return 'engine-ready';
  if (head?.startsWith('listening on')) return 'listening';
  return undefined;
}
