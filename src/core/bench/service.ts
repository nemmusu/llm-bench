import { randomUUID } from 'node:crypto';
import type { ActiveRun, RunPlan, StartRunRequest } from '../../contract/api';
import { launchParamsSchema, type EngineConfig, type EngineKind, type LaunchParams } from '../../contract/engines';
import { AppError } from '../../contract/errors';
import type { RunPhase, ServerEvent } from '../../contract/events';
import type { HardwareFingerprint } from '../../contract/hardware';
import type { FitEstimate } from '../../contract/models';
import type { Scenario } from '../../contract/results';
import type { Clock } from '../deps';
import type { EngineAdapter, LaunchPlan, ModelTarget } from '../engines/types';
import { newRunId } from '../store/runs-id';
import { engineLabelOf, type HereIdentity, type RunsRepo } from '../store/runs-repo';
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
   */
  resolveModel: (req: StartRunRequest, opts?: { preview?: boolean }) => Promise<ModelTarget>;
  /** A free 127.0.0.1 port for the engine. */
  pickPort: () => Promise<number>;
  /** Ownership marker for the engine process/container (default gpubench-<uuid>). */
  newMarker?: () => string;
  newRunId?: () => string;
  /** Downloads/installs the run needs first (engine, model, image), for the plan preview. */
  needs?: (req: StartRunRequest, model: ModelTarget) => Promise<RunPlan['needs']>;
  /** VRAM fit estimate for the plan preview and the run's VRAM "estimate vs measured". */
  fit?: (req: StartRunRequest, model: ModelTarget, plan: LaunchPlan) => Promise<FitEstimate | undefined>;
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
  adjustEngine?: (req: StartRunRequest, model: ModelTarget) => Promise<EngineConfig | undefined>;
  /** Reason a run cannot start right now (e.g. a GPU Bench server holds the GPU), or undefined. */
  blockedBy?: () => AppError | undefined;
}

export type { ActiveRun };

interface Current {
  runId: string;
  phase: RunPhase;
  progress: number;
  controller: AbortController;
  done: Promise<void>;
  /** What GET /api/runs/active shows besides phase and progress; set once the run is prepared. */
  info?: Omit<ActiveRun, 'runId' | 'phase' | 'progress'>;
}

interface Prepared {
  model: ModelTarget;
  adapter: EngineAdapter;
  /** The engine configuration actually used (adjustEngine may add a Docker model volume…). */
  engine: EngineConfig;
  params: LaunchParams;
  port: number;
  marker: string;
  launch: LaunchPlan;
  scenario: Scenario;
  warnings: ScenarioWarning[];
}

/** vLLM's default gpu_memory_utilization, and the VRAM left free when GPU Bench lowers it. */
const VLLM_DEFAULT_UTILIZATION = 0.9;
const VLLM_FREE_MARGIN_MIB = 768;

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

  /** `preview`: plan before installs/downloads (missing engine/model become their future paths). */
  private async prepare(req: StartRunRequest, preview: boolean): Promise<Prepared> {
    const scenario = this.scenarioFor(req);
    const model = await this.deps.resolveModel(req, { preview });
    const adapter = this.deps.getAdapter(req.engine.kind);
    const modelContext = model.identity.facts?.contextLength;
    const params = autoLaunchParams(req.engine.kind, scenario, req.params ?? launchParamsSchema.parse({}), modelContext);
    const memWarning = await this.fitVllmMemory(req.engine.kind, params);
    const port = await this.deps.pickPort();
    const marker = this.deps.newMarker?.() ?? `gpubench-${randomUUID()}`;
    const engine = (await this.deps.adjustEngine?.(req, model)) ?? req.engine;
    const launch = await adapter.plan(engine, model, params, { port, marker, preview });
    const kvUnified = launch.argv.includes('--kv-unified');
    const fitted = fitScenario(scenario, limitsFor(req.engine.kind, launch.params, modelContext, { kvUnified }));
    const warnings = memWarning ? [memWarning, ...fitted.warnings] : fitted.warnings;
    return { model, adapter, engine, params, port, marker, launch, scenario: fitted.scenario, warnings };
  }

  /**
   * vLLM reserves gpu_memory_utilization × total VRAM up front (default 0.9) and refuses to start when
   * that much is not free. When other programs hold VRAM and the user did not choose a value, use what
   * is actually free (minus a margin) so the run can still happen; the run notes say so. Below 20 % the
   * model will not fit anyway and the normal VRAM checks report it.
   */
  private async fitVllmMemory(kind: EngineKind, params: LaunchParams): Promise<ScenarioWarning | undefined> {
    if ((kind !== 'vllm-docker' && kind !== 'vllm-native') || params.gpuMemoryUtilization !== undefined) return undefined;
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

  /** Speeds from the latest completed run of this model on this PC, to estimate durations. */
  private async expectations(model: ModelTarget): Promise<Partial<Expectations>> {
    try {
      const here = await this.here();
      const id = model.identity;
      const past = (await this.deps.runs.tried({ ...(id.sha256 ? { sha256: id.sha256 } : {}), weakKey: id.weakKey }, here)).find(
        (r) => r.status === 'completed' && r.hostId === here.hostId,
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
   * Preview for "Anteprima comando": exact command, downloads needed, duration, VRAM fit, warnings.
   * Works before the engine is installed or the model downloaded: the command then names where they
   * will be (`pending`), and `needs` lists them with their sizes.
   */
  async plan(req: StartRunRequest): Promise<RunPlan> {
    const p = await this.prepare(req, true);
    const shown = launchRecordOf(p.launch, this.deps.displayCommand, this.deps.redact);
    const needs = (await this.deps.needs?.(req, p.model)) ?? [];
    const fit = await this.deps.fit?.(req, p.model, p.launch);
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
    if (fit?.level === 'no') warnings.push({ code: 'MODEL_TOO_LARGE', params: { needMiB: fit.needMiB, availableMiB: fit.availableMiB } });
    if (fit?.level === 'partial') warnings.push({ code: 'partial_offload', params: { maxGpuLayers: fit.maxGpuLayers } });
    if (this.deps.slowSharedFilesystem?.(p.launch, p.model)) warnings.push({ code: 'slow_shared_filesystem' });
    return {
      scenario: p.scenario,
      command: { argv: shown.argv, ...shown.display },
      needs,
      ...(p.launch.pending ? { pending: p.launch.pending } : {}),
      estimatedSeconds: estimateSeconds(p.scenario, await this.expectations(p.model)),
      ...(fit ? { fit } : {}),
      warnings,
    };
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
    const current: Current = { runId, phase: 'prepare', progress: 0, controller, done: Promise.resolve() };
    this.current = current;
    let p: Prepared;
    let fit: FitEstimate | undefined;
    let interval: number | undefined;
    try {
      // Never a preview: a missing engine or model fails here (ENGINE_NOT_INSTALLED / MODEL_NOT_FOUND).
      p = await this.prepare(req, false);
      fit = await d.fit?.(req, p.model, p.launch).catch(() => undefined);
      interval = await d.telemetryIntervalMs?.();
      current.info = {
        startedAt,
        profile: p.scenario.profile,
        estimatedSeconds: estimateSeconds(p.scenario, await this.expectations(p.model)),
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
    return { runId: c.runId, phase: c.phase, progress: c.progress, ...c.info };
  }

  /** Resolves when no run is active (tests, shutdown). */
  async whenIdle(): Promise<void> {
    await this.current?.done;
  }
}
