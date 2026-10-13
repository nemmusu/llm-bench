import { randomUUID } from 'node:crypto';
import type { ActiveRun, RunPlan, ServerPlan, StartRunRequest, StartServerRequest } from '../../contract/api';
import { engineBaseOf, launchParamsSchema, type EngineConfig, type EngineKind, type LaunchParams } from '../../contract/engines';
import { AppError } from '../../contract/errors';
import type { LivePoint, RunPhase, ServerEvent } from '../../contract/events';
import type { HardwareFingerprint } from '../../contract/hardware';
import type { FitEstimate } from '../../contract/models';
import { spilledRun, type Scenario, type TuneBudget } from '../../contract/results';
import type { Clock } from '../deps';
import type { EngineAdapter, LaunchPlan, ModelTarget } from '../engines/types';
import { availableNowMiB, levelNowOf } from '../models/fit';
import { serverApiName } from '../engines/types';
import { newRunId } from '../store/runs-id';
import { engineBuildOf, engineLabelOf, type HereIdentity, type RunsRepo } from '../store/runs-repo';
import type { TelemetrySampler } from '../telemetry/types';
import { loadCorpus } from './prompts';
import { BenchRunner, launchRecordOf, type RunInput, type RunnerDeps } from './runner';
import {
  autoLaunchParams,
  buildScenario,
  estimateSeconds,
  fitScenario,
  limitsFor,
  type Expectations,
  type ScenarioWarning,
} from './scenarios';
import { loadScoreReference } from './score';
import { cpuOffloaded, normalDecode, spillPossible, type NormalDecode } from './spill';
import { tuneTime } from './tune-run';
import { buildTuneSetup, latestTuneRun, recheckInputOf, recheckSource, tuneGoalOf, tunedServerParams, type TuneSetupDeps } from './tune-setup';
import { BUDGETS, type TunerInput } from './tuner';

export interface BenchServiceDeps {
  clock: Clock;
  runs: RunsRepo;
  publish: (e: ServerEvent) => void;
  telemetry: TelemetrySampler;
  fingerprint: () => Promise<HardwareFingerprint>;
  displayCommand: RunnerDeps['displayCommand'];
  /** Secret redaction for stored/previewed commands (engines' redactArgv/redactEnv). */
  redact?: RunnerDeps['redact'];
  getAdapter: (kind: EngineKind) => EngineAdapter;
  /**
   * Local model / HF repo / external name → what the engine loads. Throws AppError (MODEL_NOT_FOUND…).
   * With `preview`, a hub GGUF that is not downloaded yet resolves to its pending download.
   * Runs and servers share these helpers: they only read the engine, the model and the params.
   */
  resolveModel: (req: StartServerRequest, opts?: { preview?: boolean }) => Promise<ModelTarget>;
  /** A free 127.0.0.1 port for the engine. */
  pickPort: () => Promise<number>;
  /** Ownership marker for the engine process/container of a run (default gpubench-<uuid>). */
  newMarker?: () => string;
  newRunId?: () => string;
  /** Downloads/installs the run needs first (engine, model, image), for the plan preview. */
  needs?: (req: StartServerRequest, model: ModelTarget) => Promise<RunPlan['needs']>;
  /** VRAM fit estimate (FREE VRAM) of the model with these params: plan previews, server settings, the run's "estimate vs measured". */
  fit?: (req: StartServerRequest, model: ModelTarget, plan: Pick<LaunchPlan, 'params'>) => Promise<FitEstimate | undefined>;
  /** true when the model is read through a 9p/drvfs share (Docker Desktop on Windows, WSL /mnt/c). */
  slowSharedFilesystem?: (plan: LaunchPlan, model: ModelTarget) => boolean;
  evictCache?: RunnerDeps['evictCache'];
  llamaBench?: RunnerDeps['llamaBench'];
  appVersion: string;
  cacheDir: string;
  /** Bundled resources (corpus/, score-reference.json). */
  resourcesDir: string;
  ownPids: () => number[];
  /** Telemetry sampling interval (settings.telemetryIntervalMs). */
  telemetryIntervalMs?: () => number | Promise<number>;
  /** Core shutdown: cancels the active run (which is then saved as cancelled). */
  shutdown?: AbortSignal;
  /** Last-minute engine tweaks the user never has to think about (e.g. use the model's Docker volume copy). */
  adjustEngine?: (req: StartServerRequest, model: ModelTarget) => Promise<EngineConfig | undefined>;
  /** Reason a run cannot start right now (e.g. a GPU Bench server holds the GPU), or undefined. */
  blockedBy?: () => AppError | undefined;
  /** Fit estimate corrected with the VRAM peaks measured on this GPU (the tuner's pruning). */
  calibration?: TuneSetupDeps['calibration'];
}

export type { ActiveRun };

interface Current {
  runId: string;
  phase: RunPhase;
  progress: number;
  controller: AbortController;
  done: Promise<void>;
  /** What GET /api/runs/active shows besides phase and progress; set once the run is prepared. */
  info?: Omit<ActiveRun, 'runId' | 'phase' | 'progress' | 'tuning' | 'launch' | 'current' | 'points' | 'loading' | 'remainingSeconds' | 'spill'>;
  /** Latest run.tune / run.launch / run.step / run.spill / time left, and every run.point (latest per key). */
  live: Pick<ActiveRun, 'tuning' | 'launch' | 'current' | 'loading' | 'remainingSeconds' | 'spill'> & { points: Map<string, LivePoint> };
}

/** Which earlier run.point a new one replaces: same kind, same prompt length, users or conversations, same tune attempt. */
export function livePointKey(p: LivePoint): string {
  if (p.stepKind === 'concurrency') return `concurrency:${p.point.level}`;
  if (p.stepKind === 'sessions') return `sessions:${p.point.sessions}`;
  return `${p.stepKind}:${p.point.promptTokens}:${p.attempt ?? ''}`;
}

/** A request resolved down to the exact command (runs and servers alike). */
interface Launched {
  model: ModelTarget;
  adapter: EngineAdapter;
  /** The engine configuration actually used (adjustEngine may add a Docker model volume…). */
  engine: EngineConfig;
  params: LaunchParams;
  port: number;
  marker: string;
  launch: LaunchPlan;
  warnings: ScenarioWarning[];
}

interface Prepared extends Launched {
  scenario: Scenario;
}

/** A server ready to start ("Avvia solo il server"): the command plus the context it will offer. */
export interface PreparedServer extends Launched {
  /** Tokens the server takes at once: llama.cpp ctx-size, vLLM max-model-len. */
  contextSize: number;
  /** The model name other programs use with this server. */
  apiName: string;
  /** The context and settings came from a "Trova le impostazioni migliori" run (see tunedServerParams). */
  tuned?: ServerPlan['tuned'];
  /** Usual start → ready time here (a server start reads files the OS has usually cached: the warm time, else the cold one). */
  expectedLoadMs?: number;
}

/** Plan fields shared by runs and servers. */
type Preview = Pick<RunPlan, 'command' | 'needs' | 'pending' | 'fit' | 'warnings'>;

/** vLLM's default gpu_memory_utilization, and the VRAM left free when GPU Bench lowers it. */
const VLLM_DEFAULT_UTILIZATION = 0.9;
const VLLM_FREE_MARGIN_MIB = 768;

/**
 * Contexts tried for a server, largest first: the largest that fits the card well wins. Capped at
 * the model's trained context; without a fit estimate the fallback is used.
 */
export const SERVER_CONTEXTS = [32768, 16384, 8192, 4096] as const;
export const SERVER_FALLBACK_CONTEXT = 8192;

/** vLLM and SGLang: max-model-len / context-length, and a memory share reserved up front. */
const isVllm = (kind: EngineKind): boolean => {
  const base = engineBaseOf(kind);
  return base === 'vllm' || base === 'sglang';
};

/**
 * Plan warnings of the launch itself: GPU Bench flags the build does not know (a fork), left out of
 * the command so the engine's own default applies ('flag_unsupported').
 */
export function launchWarnings(launch: Pick<LaunchPlan, 'unsupported' | 'engine'>): ScenarioWarning[] {
  const missing = launch.unsupported ?? [];
  if (missing.length === 0) return [];
  return [{ code: 'flag_unsupported', params: { engine: launch.engine.name, flags: missing.map((m) => m.flag).join(' '), settings: missing.map((m) => m.setting).join(',') } }];
}

/** The context a server offers with these params: llama.cpp ctx-size, vLLM max-model-len (or ctx-size). */
export function serverContextOf(kind: EngineKind, params: LaunchParams): number | undefined {
  return isVllm(kind) ? (params.maxModelLen ?? params.contextSize) : params.contextSize;
}

/** Starts, tracks and cancels benchmark runs: one at a time (the GPU is the shared resource). */
export class BenchService {
  private readonly deps: BenchServiceDeps;
  private current: Current | undefined;
  private corpusText: Promise<string> | undefined;
  private hereCache: HereIdentity | undefined;

  constructor(deps: BenchServiceDeps) {
    this.deps = deps;
    deps.shutdown?.addEventListener('abort', () => this.current?.controller.abort(), { once: true });
  }

  /** The scenario a request asks for, before fitting it to the engine. */
  scenarioFor(req: StartRunRequest): Scenario {
    if (req.profile !== 'custom') return buildScenario(req.profile, req.scenario?.seed);
    if (!req.scenario) {
      throw new AppError('VALIDATION', 'A custom profile needs a scenario', { params: { reason: 'scenario_required' } });
    }
    return { ...req.scenario, profile: 'custom' };
  }

  /**
   * The exact command for `params`: a free port, the ownership marker, last-minute engine tweaks.
   * `preview`: plan before installs/downloads (missing engine/model become their future paths).
   */
  private async command(
    req: StartServerRequest,
    model: ModelTarget,
    adapter: EngineAdapter,
    params: LaunchParams,
    o: { preview: boolean; marker: () => string; apiName?: string },
  ): Promise<Pick<Launched, 'engine' | 'port' | 'marker' | 'launch'>> {
    const port = await this.deps.pickPort();
    const marker = o.marker();
    const engine = (await this.deps.adjustEngine?.(req, model)) ?? req.engine;
    const launch = await adapter.plan(engine, model, params, { port, marker, preview: o.preview, ...(o.apiName !== undefined ? { apiName: o.apiName } : {}) });
    return { engine, port, marker, launch };
  }

  private async prepare(req: StartRunRequest, preview: boolean): Promise<Prepared> {
    const scenario = this.scenarioFor(req);
    const model = await this.deps.resolveModel(req, { preview });
    const adapter = this.deps.getAdapter(req.engine.kind);
    const modelContext = model.identity.facts?.contextLength;
    if (scenario.profile === 'tune' && req.engine.kind === 'external') {
      throw new AppError('VALIDATION', 'An external endpoint cannot be relaunched with other settings', { params: { reason: 'tune_external' } });
    }
    // A command template only takes the context: there are no settings to search.
    if (scenario.profile === 'tune' && req.engine.kind === 'command') {
      throw new AppError('VALIDATION', 'A command engine has no settings to search', { params: { reason: 'tune_command' } });
    }
    const params = autoLaunchParams(req.engine.kind, scenario, req.params ?? launchParamsSchema.parse({}), modelContext);
    const memWarning = await this.fitVllmMemory(req.engine.kind, params);
    const c = await this.command(req, model, adapter, params, { preview, marker: () => this.deps.newMarker?.() ?? `gpubench-${randomUUID()}` });
    const kvUnified = c.launch.argv.includes('--kv-unified');
    // A tune run picks its contexts itself (the tuner): its sweep template stays as it is.
    const fitted = scenario.profile === 'tune' ? { scenario, warnings: [] } : fitScenario(scenario, limitsFor(req.engine.kind, c.launch.params, modelContext, { kvUnified }));
    const warnings = [...(memWarning ? [memWarning] : []), ...launchWarnings(c.launch), ...fitted.warnings];
    return { model, adapter, params, ...c, scenario: fitted.scenario, warnings };
  }

  /**
   * "Avvia solo il server": the request's params, and the recommended value of whatever the user left
   * unset — the context that fits this card (see recommendedContext), vLLM's memory share lowered to
   * the free VRAM (fitVllmMemory). Everything else (parallel 1, Docker model volume…) as for runs.
   * Without `preview` a missing engine or model fails (ENGINE_NOT_INSTALLED / MODEL_NOT_FOUND).
   */
  async prepareServer(req: StartServerRequest, opts: { preview: boolean; marker: string }): Promise<PreparedServer> {
    if (req.engine.kind === 'external') throw new AppError('VALIDATION', 'External endpoints are already running', { params: { reason: 'external' } });
    const model = await this.deps.resolveModel(req, { preview: opts.preview });
    const adapter = this.deps.getAdapter(req.engine.kind);
    // No context chosen: the latest "Trova le impostazioni migliori" of this model here decides, if any.
    const userParams = req.params ?? launchParamsSchema.parse({});
    const tuned = serverContextOf(req.engine.kind, userParams) === undefined ? await this.tunedServer(req, model, adapter) : undefined;
    const params: LaunchParams = { ...(tuned?.params ?? userParams) };
    const memWarning = await this.fitVllmMemory(req.engine.kind, params);
    const contextSize = await this.fillServerContext(req, model, params);
    const apiName = serverApiName(req.engine.kind, model);
    const c = await this.command(req, model, adapter, params, { preview: opts.preview, marker: () => opts.marker, apiName });
    const past = opts.preview ? undefined : (await this.expectedLoad(model, req.engine.kind)).expectedLoadMs;
    const expectedLoadMs = past?.warm ?? past?.cold;
    return {
      model,
      adapter,
      params,
      ...c,
      contextSize,
      apiName,
      warnings: [...(memWarning ? [memWarning] : []), ...launchWarnings(c.launch)],
      ...(tuned ? { tuned: tuned.tuned } : {}),
      ...(expectedLoadMs !== undefined ? { expectedLoadMs } : {}),
    };
  }

  private async tunedServer(req: StartServerRequest, model: ModelTarget, adapter: EngineAdapter): ReturnType<typeof tunedServerParams> {
    const here = await this.here().catch(() => undefined);
    if (!here) return undefined;
    return tunedServerParams(this.deps.runs, here, req, model, () => this.currentBuild(req, model, adapter, req.params ?? launchParamsSchema.parse({})));
  }

  /**
   * The engine build or image a launch would use now (a preview plan: nothing starts), so tune results
   * of another build are told apart. undefined when it cannot be known.
   */
  private async currentBuild(req: StartServerRequest, model: ModelTarget, adapter: EngineAdapter, params: LaunchParams): Promise<string | undefined> {
    const engine = (await this.deps.adjustEngine?.(req, model).catch(() => undefined)) ?? req.engine;
    const plan = await adapter.plan(engine, model, params, { port: 0, marker: 'gpubench-build', preview: true }).catch(() => undefined);
    return plan ? engineBuildOf(plan.engine) : undefined;
  }

  /** Sets the context the user left unset to the recommended one; returns the context the server will offer. */
  private async fillServerContext(req: StartServerRequest, model: ModelTarget, params: LaunchParams): Promise<number> {
    const chosen = serverContextOf(req.engine.kind, params);
    if (chosen !== undefined) return chosen;
    const ctx = await this.recommendedContext(req, model, params);
    if (isVllm(req.engine.kind)) params.maxModelLen = ctx;
    else params.contextSize = ctx;
    return ctx;
  }

  /**
   * The largest of SERVER_CONTEXTS (capped at the model's trained context) whose fit for a launch right
   * now (`levelNow`: the VRAM free now, at most total − reserve) is perfect or good; else the largest
   * that is tight; else the smallest (the fit then reports the partial offload). The server starts now,
   * with whatever else is open. Without a fit estimate (no fit service, a vLLM repo not downloaded
   * yet), the fallback capped at the model's context.
   */
  private async recommendedContext(req: StartServerRequest, model: ModelTarget, params: LaunchParams): Promise<number> {
    const max = model.identity.facts?.contextLength;
    const cap = (n: number) => (max ? Math.min(n, max) : n);
    const candidates = [...new Set(SERVER_CONTEXTS.map(cap))];
    const vllm = isVllm(req.engine.kind);
    let tight: number | undefined;
    for (const ctx of candidates) {
      const withCtx: LaunchParams = vllm ? { ...params, maxModelLen: ctx } : { ...params, contextSize: ctx };
      const fit = await this.deps.fit?.(req, model, { params: withCtx }).catch(() => undefined);
      if (!fit) return cap(SERVER_FALLBACK_CONTEXT);
      const now = levelNowOf(fit);
      if (now === 'perfect' || now === 'good') return ctx;
      if (now === 'tight') tight ??= ctx;
    }
    return tight ?? (candidates.at(-1) as number);
  }

  /**
   * vLLM reserves gpu_memory_utilization × total VRAM up front (default 0.9) and refuses to start when
   * that much is not free. When other programs hold VRAM and the user did not choose a value, use what
   * is actually free (minus a margin) so the run can still happen; the run notes say so. Below 20 % the
   * model will not fit anyway and the normal VRAM checks report it.
   */
  private async fitVllmMemory(kind: EngineKind, params: LaunchParams): Promise<ScenarioWarning | undefined> {
    if (!isVllm(kind) || params.gpuMemoryUtilization !== undefined) return undefined;
    const g = (await this.deps.telemetry.snapshot().catch(() => []))[0];
    if (!g?.memTotalMiB || g.memUsedMiB === null) return undefined;
    const free = g.memTotalMiB - g.memUsedMiB;
    if (free >= VLLM_DEFAULT_UTILIZATION * g.memTotalMiB + VLLM_FREE_MARGIN_MIB) return undefined;
    const util = Math.floor(((free - VLLM_FREE_MARGIN_MIB) / g.memTotalMiB) * 100) / 100;
    if (util < 0.2) return undefined;
    params.gpuMemoryUtilization = util;
    return { code: 'gpu_memory_reduced', params: { utilization: util, freeMiB: free, totalMiB: g.memTotalMiB } };
  }

  /** "This PC + GPU", for ranking past results. Cached once known. */
  async here(): Promise<HereIdentity> {
    if (this.hereCache) return this.hereCache;
    const fp = await this.deps.fingerprint();
    const gpu = fp.gpus[0];
    this.hereCache = { hostId: fp.hostId, ...(gpu ? { gpuUuid: gpu.uuid, gpuName: gpu.name } : {}) };
    return this.hereCache;
  }

  /** Speeds from the latest completed run of this model on this PC that did not spill, to estimate durations. */
  private async expectations(model: ModelTarget): Promise<Partial<Expectations>> {
    try {
      const here = await this.here();
      const id = model.identity;
      const past = (await this.deps.runs.tried({ ...(id.sha256 ? { sha256: id.sha256 } : {}), weakKey: id.weakKey }, here)).find(
        (r) => r.status === 'completed' && r.hostId === here.hostId && !spilledRun(r),
      );
      if (!past) return {};
      return {
        ...(past.decodeTps ? { decodeTps: past.decodeTps } : {}),
        ...(past.prefillTps ? { prefillTps: past.prefillTps } : {}),
        ...(past.coldLoadMs ? { coldLoadSec: past.coldLoadMs / 1000 } : {}),
        ...(past.warmLoadMs ? { warmLoadSec: past.warmLoadMs / 1000 } : {}),
      };
    } catch {
      return {};
    }
  }

  /**
   * Usual start → ready time of this model with this engine kind on this PC: the latest completed run
   * that measured it and did not spill ("di solito ci mette circa 45 s"). Never fails: unknown is simply absent.
   */
  async expectedLoad(model: ModelTarget, kind: EngineKind): Promise<{ expectedLoadMs?: { cold?: number; warm?: number } }> {
    try {
      const here = await this.here();
      const id = model.identity;
      const past = (await this.deps.runs.tried({ ...(id.sha256 ? { sha256: id.sha256 } : {}), weakKey: id.weakKey }, here)).filter(
        (r) => r.status === 'completed' && r.hostId === here.hostId && r.engineKind === kind && !spilledRun(r),
      );
      const cold = past.find((r) => r.coldLoadMs !== undefined)?.coldLoadMs;
      const warm = past.find((r) => r.warmLoadMs !== undefined)?.warmLoadMs;
      if (cold === undefined && warm === undefined) return {};
      return { expectedLoadMs: { ...(cold !== undefined ? { cold } : {}), ...(warm !== undefined ? { warm } : {}) } };
    } catch {
      return {};
    }
  }

  /** What a normal run needs to tell a spill: the usual speed here, and what would fit (from the run's own fit estimate). */
  private async spillInputs(p: Prepared, fit: FitEstimate | undefined): Promise<Pick<RunInput, 'normalDecode' | 'fitFixes'>> {
    const normal = await this.normalDecode(p.model, p.engine.kind);
    return { ...(normal ? { normalDecode: normal } : {}), ...(fit?.fixes ? { fitFixes: fit.fixes } : {}) };
  }

  /**
   * The usual generation speed of this model and engine kind on this GPU (earlier runs that did not
   * spill): a run generating far slower on a short prompt spilled. Never fails: unknown is absent.
   */
  private async normalDecode(model: ModelTarget, kind: EngineKind): Promise<NormalDecode | undefined> {
    try {
      const here = await this.here();
      const id = model.identity;
      return normalDecode(await this.deps.runs.tried({ ...(id.sha256 ? { sha256: id.sha256 } : {}), weakKey: id.weakKey }, here), here, kind);
    } catch {
      return undefined;
    }
  }

  /**
   * Expected seconds of a "Trova le impostazioni migliori" with this budget: the search's own forecast
   * for this model here (predicted contexts, expected speeds, launches); the budget's shortest time
   * limit when it cannot be prepared (nothing to re-check).
   */
  private async tuneDuration(req: StartRunRequest, p: Prepared, budget: TuneBudget): Promise<number> {
    const input = await this.tuneSetup({ ...req, tune: { ...(req.tune ?? { fidelity: false }), budget } }, p, true).catch(() => undefined);
    return input ? Math.round(tuneTime(input).estimateMs / 1000) : BUDGETS[budget].minMs / 1000;
  }

  /**
   * Preview for "Anteprima comando": exact command, downloads needed, duration, VRAM fit, warnings.
   * Works before the engine is installed or the model downloaded: the command then names where they
   * will be (`pending`), and `needs` lists them with their sizes. A tune plan also says how long each
   * budget would take for this model.
   */
  async plan(req: StartRunRequest): Promise<RunPlan> {
    const p = await this.prepare(req, true);
    const preview = await this.preview(req, p);
    if (p.scenario.profile !== 'tune') return { scenario: p.scenario, ...preview, estimatedSeconds: estimateSeconds(p.scenario, await this.expectations(p.model)) };
    const previousTune = await this.previousTune(req, p);
    const tuneSeconds = { fast: await this.tuneDuration(req, p, 'fast'), thorough: await this.tuneDuration(req, p, 'thorough') };
    const budget = req.tune?.budget ?? 'fast';
    const estimatedSeconds = budget === 'recheck' ? await this.tuneDuration(req, p, budget) : tuneSeconds[budget];
    return { scenario: p.scenario, ...preview, estimatedSeconds, tuneSeconds, ...(previousTune ? { previousTune } : {}) };
  }

  /** The latest tune of this model here with the same question, and whether it ran with this build. */
  private async previousTune(req: StartRunRequest, p: Prepared): Promise<RunPlan['previousTune']> {
    try {
      const here = await this.here();
      const id = p.model.identity;
      const list = await this.deps.runs.tried({ ...(id.sha256 ? { sha256: id.sha256 } : {}), weakKey: id.weakKey }, here);
      const last = latestTuneRun(list, here, req.engine.kind, tuneGoalOf(req));
      if (!last) return undefined;
      const current = engineBuildOf(p.launch.engine);
      return {
        runId: last.id,
        createdAt: last.createdAt,
        // A tune run's summary always says its budget.
        budget: last.tuneBudget as TuneBudget,
        ...(last.engineBuild !== undefined ? { build: last.engineBuild } : {}),
        ...(current !== undefined ? { currentBuild: current } : {}),
        sameBuild: last.engineBuild === current,
      };
    } catch {
      return undefined;
    }
  }

  /**
   * Preview of "Avvia solo il server" (POST /api/servers/plan): exact command, downloads needed, the
   * effective params with the context chosen for this card, VRAM fit and warnings.
   */
  async planServer(req: StartServerRequest): Promise<ServerPlan> {
    const p = await this.prepareServer(req, { preview: true, marker: `gpubench-${randomUUID()}` });
    const preview = await this.preview(req, p);
    return { ...preview, params: p.launch.params, contextSize: p.contextSize, ...(p.tuned ? { tuned: p.tuned } : {}) };
  }

  /**
   * What the VRAM verdict means for this launch, started right now (`levelNow`: the VRAM free now, at
   * most total − reserve; the headline `level` judges the card's total and stays as it is). llama.cpp
   * with every layer on the GPU (the default) that does not fit entirely is not a partial offload: under
   * Windows (and WSL) the rest goes to shared system memory and everything is ~10–15× slower
   * ('spill_risk'); elsewhere it runs out of memory ('oom_risk', or MODEL_TOO_LARGE when not even part
   * of it fits). `availableMiB` in their params is what is free now ("servono X, ne hai Y liberi"); the
   * settings that would fit come with them (fit.fixes). Fewer layers chosen on purpose: 'partial_offload'.
   */
  private async fitWarnings(p: Launched, fit: FitEstimate): Promise<ScenarioWarning[]> {
    const kind = p.launch.kind;
    const now = levelNowOf(fit);
    const sizes = { needMiB: fit.needMiB, availableMiB: availableNowMiB(fit) };
    const llama = kind === 'llamacpp-native' || kind === 'llamacpp-docker';
    if (now !== 'partial' && now !== 'no') return [];
    const allOnGpu = llama && !cpuOffloaded(kind, p.launch, p.model.identity.facts?.blockCount);
    if (allOnGpu && spillPossible((await this.deps.fingerprint().catch(() => undefined))?.os)) return [{ code: 'spill_risk', params: { ...sizes, ...fit.fixes } }];
    if (now === 'no') return [{ code: 'MODEL_TOO_LARGE', params: sizes }];
    return [allOnGpu ? { code: 'oom_risk', params: { ...sizes, ...fit.fixes } } : { code: 'partial_offload', params: { maxGpuLayers: fit.maxGpuLayers } }];
  }

  /** What runs and servers show before starting: redacted command, needs, fit and the warnings about this PC. */
  private async preview(req: StartServerRequest, p: Launched): Promise<Preview> {
    const shown = launchRecordOf(p.launch, this.deps.displayCommand, this.deps.redact);
    const needs = (await this.deps.needs?.(req, p.model)) ?? [];
    // A fit that cannot be estimated never blocks the preview.
    const fit = await this.deps.fit?.(req, p.model, p.launch).catch(() => undefined);
    const warnings: RunPlan['warnings'] = [...p.warnings];
    if (await this.deps.telemetry.available().catch(() => false)) {
      const llms = (await this.deps.telemetry.otherGpuUsers(this.deps.ownPids()).catch(() => [])).filter((u) => u.knownLlm);
      if (llms.length) {
        warnings.push({
          code: 'VRAM_BUSY',
          params: { names: llms.map((u) => u.name).join(', '), pids: llms.map((u) => u.pid).join(', ') },
        });
      }
    }
    warnings.push(...(fit ? await this.fitWarnings(p, fit) : []));
    if (this.deps.slowSharedFilesystem?.(p.launch, p.model)) warnings.push({ code: 'slow_shared_filesystem' });
    return {
      command: { argv: shown.argv, ...shown.display },
      needs,
      ...(p.launch.pending ? { pending: p.launch.pending } : {}),
      ...(fit ? { fit } : {}),
      warnings,
    };
  }

  /**
   * What the tuner searches; "Ricontrollo rapido" needs an earlier tune of this model here (VALIDATION
   * 'recheck_nothing'). `forecast`: only for the plan's duration.
   */
  private async tuneSetup(req: StartRunRequest, p: Prepared, forecast = false): Promise<TunerInput> {
    const d = this.deps;
    let recheck: Parameters<typeof buildTuneSetup>[3];
    if (req.tune?.budget === 'recheck') {
      const here = await this.here();
      const run = await recheckSource(d.runs, here, req, p.model);
      if (!run) throw new AppError('VALIDATION', 'No earlier tune of this model here to re-check', { params: { reason: 'recheck_nothing' } });
      recheck = recheckInputOf(run, engineBuildOf(p.launch.engine));
    }
    return buildTuneSetup(
      {
        telemetry: d.telemetry,
        fingerprint: d.fingerprint,
        runs: d.runs,
        here: () => this.here(),
        ...(d.calibration ? { calibration: d.calibration } : {}),
      },
      req,
      p,
      recheck,
      { forecast },
    );
  }

  private corpus(): Promise<string> {
    this.corpusText ??= loadCorpus(this.deps.resourcesDir).catch((e: unknown) => {
      this.corpusText = undefined;
      throw e;
    });
    return this.corpusText;
  }

  /**
   * Starts a run in the background and returns its id. Fails fast (nothing saved) when another
   * run is active or the request cannot be resolved; once started, a RunResult is always saved.
   */
  async start(req: StartRunRequest): Promise<{ runId: string }> {
    if (this.current) {
      throw new AppError('RUN_IN_PROGRESS', 'run already in progress', {
        params: { reason: 'run_in_progress', runId: this.current.runId },
      });
    }
    const blocked = this.deps.blockedBy?.();
    if (blocked) throw blocked;
    const d = this.deps;
    const runId = d.newRunId?.() ?? newRunId(d.clock.wall());
    const startedAt = new Date(d.clock.wall()).toISOString();
    const controller = new AbortController();
    // Claimed before the first await so two concurrent starts cannot both pass the check.
    const current: Current = { runId, phase: 'prepare', progress: 0, controller, done: Promise.resolve(), live: { points: new Map() } };
    this.current = current;
    let p: Prepared;
    let fit: FitEstimate | undefined;
    let interval: number | undefined;
    let tune: RunInput['tune'];
    try {
      // Never a preview: a missing engine or model fails here (ENGINE_NOT_INSTALLED / MODEL_NOT_FOUND).
      p = await this.prepare(req, false);
      fit = await d.fit?.(req, p.model, p.launch).catch(() => undefined);
      interval = await d.telemetryIntervalMs?.();
      if (p.scenario.profile === 'tune') tune = await this.tuneSetup(req, p);
      current.info = {
        startedAt,
        profile: p.scenario.profile,
        // A tune run: the search's own forecast (the same the runner's progress follows).
        estimatedSeconds: tune ? Math.round(tuneTime(tune).estimateMs / 1000) : estimateSeconds(p.scenario, await this.expectations(p.model)),
        modelName: p.model.identity.displayName,
        engineLabel: engineLabelOf(p.launch.engine),
        scenario: p.scenario,
      };
    } catch (e) {
      this.current = undefined;
      throw e;
    }
    const runner = new BenchRunner({
      clock: d.clock,
      adapter: p.adapter,
      telemetry: d.telemetry,
      runs: d.runs,
      publish: (e) => {
        if (e.type === 'run.phase') {
          current.phase = e.phase;
          current.progress = e.progress;
          if (e.remainingSeconds !== undefined) current.live.remainingSeconds = e.remainingSeconds;
        } else if (e.type === 'run.spill') current.live.spill = e.spill;
        else if (e.type === 'run.tune') current.live.tuning = e.tuning;
        else if (e.type === 'run.launch') current.live.launch = e.launch;
        else if (e.type === 'run.load') {
          // The engine is starting: shown until it answers (the last run.load of a start is 'ready').
          const { type: _type, runId: _id, ...loading } = e;
          if (loading.stage === 'ready') delete current.live.loading;
          else current.live.loading = loading;
        }
        else if (e.type === 'run.step') current.live.current = e.current;
        else if (e.type === 'run.point') {
          // Re-inserted: the map keeps the order in which points were last updated.
          const key = livePointKey(e.live);
          current.live.points.delete(key);
          current.live.points.set(key, e.live);
        }
        d.publish(e);
      },
      fingerprint: d.fingerprint,
      displayCommand: d.displayCommand,
      ...(d.redact ? { redact: d.redact } : {}),
      ...(d.evictCache ? { evictCache: d.evictCache } : {}),
      ...(d.llamaBench ? { llamaBench: d.llamaBench } : {}),
      appVersion: d.appVersion,
      cacheDir: d.cacheDir,
      corpus: () => this.corpus(),
      scoreReference: () => loadScoreReference(d.resourcesDir),
      ownPids: d.ownPids,
      ...(interval ? { telemetryIntervalMs: interval } : {}),
    });
    const input: RunInput = {
      runId,
      engineConfig: p.engine,
      model: p.model,
      params: p.params,
      scenario: p.scenario,
      port: p.port,
      marker: p.marker,
      allowSharedGpu: req.allowSharedGpu,
      ...(req.note ? { note: req.note } : {}),
      ...(d.slowSharedFilesystem?.(p.launch, p.model) ? { slowSharedFilesystem: true } : {}),
      ...(fit ? { vramEstimateMiB: fit.needMiB } : {}),
      notes: p.warnings.map((w) => `plan: ${w.code}${w.params ? ` ${JSON.stringify(w.params)}` : ''}`),
      warnings: p.warnings,
      ...(tune ? { tune } : {}),
      ...(await this.expectedLoad(p.model, p.engine.kind)),
      ...(tune ? {} : await this.spillInputs(p, fit)),
    };
    current.done = runner
      .run(input, controller.signal)
      .then(
        () => undefined,
        () => undefined, // already published as run.error by the runner
      )
      .finally(() => {
        // start() refuses while a run is active, so the finishing run is always the current one.
        this.current = undefined;
      });
    return { runId };
  }

  /** Cancels the active run if `runId` is it. The run is still saved (status cancelled). */
  cancel(runId: string): boolean {
    if (this.current?.runId !== runId) return false;
    this.current.controller.abort();
    return true;
  }

  /** The run in progress, once it is prepared (start() has returned its id), else undefined. */
  active(): ActiveRun | undefined {
    const c = this.current;
    if (!c?.info) return undefined;
    const { points, ...live } = c.live;
    return { runId: c.runId, phase: c.phase, progress: c.progress, ...c.info, ...live, points: [...points.values()] };
  }

  /** Resolves when no run is active (tests, shutdown). */
  async whenIdle(): Promise<void> {
    await this.current?.done;
  }
}
