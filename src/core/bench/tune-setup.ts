/**
 * Glue between "Trova le impostazioni migliori" and the rest of the core: what the tuner searches for
 * this engine, model and PC (tune-space.ts), and how a finished search becomes the default of
 * "Avvia solo il server".
 */
import type { ServerPlan, StartRunRequest, StartServerRequest } from '../../contract/api';
import type { EngineConfig, EngineKind, LaunchParams } from '../../contract/engines';
import type { HardwareFingerprint } from '../../contract/hardware';
import type { RunSummary, Scenario } from '../../contract/results';
import type { LlamaCaps } from '../engines/llamacpp-native/caps';
import type { EngineAdapter, LaunchPlan, ModelTarget } from '../engines/types';
import { estimateFit, fitParamsFrom } from '../models/fit';
import type { HereIdentity, RunsRepo } from '../store/runs-repo';
import type { TelemetrySampler } from '../telemetry/types';
import { isLlamaCpp } from './scenarios';
import { llamaSpace, speculativeArgs, vllmSpace } from './tune-space';
import type { TunerInput } from './tuner';

/** VRAM kept free when vLLM's memory share is fitted to the free VRAM, and the highest share used. */
export const VLLM_TUNE_MARGIN_MIB = 768;
export const VLLM_TUNE_MAX_UTILIZATION = 0.95;
/** Sweep shape when the scenario has no context-sweep step (it always has one for profile 'tune'). */
const DEFAULT_SWEEP = { outputTokens: 128, reps: 2 };

export interface TuneSetupDeps {
  telemetry: Pick<TelemetrySampler, 'snapshot'>;
  fingerprint: () => Promise<HardwareFingerprint>;
}

export interface TunePrepared {
  model: ModelTarget;
  adapter: EngineAdapter;
  engine: EngineConfig;
  params: LaunchParams;
  launch: Pick<LaunchPlan, 'modelBytes'>;
  scenario: Scenario;
}

/** vLLM's memory share fitted to the free VRAM (the highest that loads), or undefined when unknown or too small. */
export function vllmTuneUtilization(gpu: { totalMiB: number; freeMiB: number } | undefined): number | undefined {
  if (!gpu) return undefined;
  const util = Math.floor(((gpu.freeMiB - VLLM_TUNE_MARGIN_MIB) / gpu.totalMiB) * 100) / 100;
  return util < 0.2 ? undefined : Math.min(VLLM_TUNE_MAX_UTILIZATION, util);
}

/** Everything the tuner needs for this request, measured now (free VRAM, platform, the build's flags). */
export async function buildTuneSetup(deps: TuneSetupDeps, req: Pick<StartRunRequest, 'tune' | 'engine'>, p: TunePrepared): Promise<TunerInput> {
  const kind = req.engine.kind;
  const budget = req.tune?.budget ?? 'fast';
  const g = (await deps.telemetry.snapshot().catch(() => []))[0];
  const gpu = g?.memTotalMiB && g.memUsedMiB !== null ? { totalMiB: g.memTotalMiB, freeMiB: g.memTotalMiB - g.memUsedMiB } : undefined;
  const os = (await deps.fingerprint().catch(() => undefined))?.os;
  const facts = p.model.identity.facts;
  const fileBytes = p.launch.modelBytes > 0 ? p.launch.modelBytes : p.model.identity.sizeBytes;
  const step = p.scenario.steps.find((s) => s.kind === 'context-sweep');
  const common = {
    budget,
    sweep: step ? { outputTokens: step.outputTokens, reps: step.reps } : DEFAULT_SWEEP,
    ...(facts?.contextLength !== undefined ? { modelContext: facts.contextLength } : {}),
    ...(gpu && facts ? { predict: (params: LaunchParams) => estimateFit({ facts, ...(fileBytes ? { fileBytes } : {}), gpu, engine: kind, params: fitParamsFrom(params) }) } : {}),
    // A model that does not fit spills to shared memory under WDDM (Windows, and WSL which uses it).
    spillPossible: os !== undefined && (os.platform === 'win32' || os.isWsl),
    fidelity: req.tune?.fidelity ?? false,
  };
  if (!isLlamaCpp(kind)) {
    const util = vllmTuneUtilization(gpu);
    return { ...common, space: vllmSpace({ budget, params: p.params, ...(util !== undefined ? { gpuMemoryUtilization: util } : {}) }), eager: true };
  }
  const caps = (await p.adapter.capabilities(p.engine).catch(() => undefined)) as LlamaCaps | undefined;
  const draftArgs = caps?.entries ? speculativeArgs(p.model.local, caps) : undefined;
  const layers = facts?.blockCount;
  return {
    ...common,
    space: llamaSpace({ budget, params: p.params, ...(draftArgs ? { draftArgs } : {}) }),
    ...(layers ? { offload: { layers, moe: (facts?.expertCount ?? 0) > 1 && caps?.flags.has('--n-cpu-moe') === true } } : {}),
  };
}

const family = (kind: EngineKind): 'llamacpp' | 'vllm' | 'external' => (kind === 'external' ? 'external' : isLlamaCpp(kind) ? 'llamacpp' : 'vllm');

/** The latest completed tune run of this model on this PC and card, with the same engine family. */
export function latestTuneRun(runs: readonly RunSummary[], here: HereIdentity, kind: EngineKind): RunSummary | undefined {
  return runs.find(
    (r) =>
      r.profile === 'tune' &&
      r.status === 'completed' &&
      (r.tunedCombinations ?? 0) > 0 &&
      r.hostId === here.hostId &&
      (!here.gpuUuid || !r.gpuUuid || r.gpuUuid === here.gpuUuid) &&
      family(r.engineKind) === family(kind),
  );
}

export interface TunedServer {
  params: LaunchParams;
  tuned: NonNullable<ServerPlan['tuned']>;
}

/**
 * "Avvia solo il server" when the user left the context unset: the recommended combination of the
 * latest "Trova le impostazioni migliori" of this model here (context, KV cache, flash attention,
 * batch…). Whatever the user did set wins. Undefined when there is no such run.
 */
export async function tunedServerParams(
  runs: Pick<RunsRepo, 'tried' | 'get'>,
  here: HereIdentity,
  req: StartServerRequest,
  model: ModelTarget,
): Promise<TunedServer | undefined> {
  const id = model.identity;
  const list = await runs.tried({ ...(id.sha256 ? { sha256: id.sha256 } : {}), weakKey: id.weakKey }, here).catch(() => []);
  const hit = latestTuneRun(list, here, req.engine.kind);
  const run = hit ? await runs.get(hit.id).catch(() => undefined) : undefined;
  const t = run?.tuning;
  const combo = t?.recommended !== undefined ? t.combinations[t.recommended] : undefined;
  if (!run || !combo) return undefined;
  const user = req.params;
  const params: LaunchParams = { ...combo.params };
  if (user) {
    for (const [k, v] of Object.entries(user) as [keyof LaunchParams, unknown][]) {
      if (k === 'extraArgs' || k === 'env' || v === undefined) continue;
      (params as Record<string, unknown>)[k] = v;
    }
    if (user.extraArgs.length) params.extraArgs = user.extraArgs;
    params.env = { ...combo.params.env, ...user.env };
  }
  return { params, tuned: { runId: run.id, createdAt: run.createdAt, contextSize: combo.maxContext, kvCacheType: combo.kvType } };
}
