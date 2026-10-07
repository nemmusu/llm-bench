/**
 * Glue between "Trova le impostazioni migliori" and the rest of the core: what the tuner searches for
 * this engine, model and PC (tune-space.ts), what earlier tune runs here say (values to try first,
 * the run a "Ricontrollo rapido" re-checks), and how a finished search becomes the default of
 * "Avvia solo il server". Tune results are remembered per (GPU, model, engine kind + build or image).
 */
import type { ServerPlan, StartRunRequest, StartServerRequest } from '../../contract/api';
import type { EngineConfig, EngineKind, LaunchParams } from '../../contract/engines';
import type { HardwareFingerprint } from '../../contract/hardware';
import { TUNE_MULTI_DEFAULTS, type RunResult, type RunSummary, type Scenario, type TuneGoal, type Tuning } from '../../contract/results';
import type { LlamaCaps } from '../engines/llamacpp-native/caps';
import type { EngineAdapter, LaunchPlan, ModelTarget } from '../engines/types';
import { estimateFit, fitParamsFrom, type FitCalibration } from '../models/fit';
import { engineBuildOf, type HereIdentity, type RunsRepo } from '../store/runs-repo';
import type { TelemetrySampler } from '../telemetry/types';
import { isLlamaCpp } from './scenarios';
import { MULTI_TURNS } from './tune-multi';
import { runnerUp, usersOf } from './tune-rank';
import { llamaSpace, speculativeArgs, vllmSpace, vllmUtilizations } from './tune-space';
import type { DimValue, RecheckInput, TunerInput } from './tuner';

/** VRAM kept free when vLLM's memory share is fitted to the free VRAM, and the highest share used. */
export const VLLM_TUNE_MARGIN_MIB = 768;
export const VLLM_TUNE_MAX_UTILIZATION = 0.95;
/** Sweep shape when the scenario has no context-sweep step (it always has one for profile 'tune'). */
const DEFAULT_SWEEP = { outputTokens: 128, reps: 2 };
/** Earlier tune runs read for the values to try first. */
export const LEARNED_RUNS = 8;

export interface TuneSetupDeps {
  telemetry: Pick<TelemetrySampler, 'snapshot'>;
  fingerprint: () => Promise<HardwareFingerprint>;
  /** Saved runs: values that won before on this GPU (absent = no ordering from the past). */
  runs?: Pick<RunsRepo, 'list' | 'get'>;
  here?: () => Promise<HereIdentity>;
  /** Fit estimate corrected with the VRAM peaks measured here (models/calibration.ts). */
  calibration?: (model: ModelTarget, kind: EngineKind) => Promise<FitCalibration | undefined>;
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

/** What a tune request asks for: the goal, and for 'multi' its users and context per user. */
export function tuneGoalOf(req: Pick<StartRunRequest, 'tune'>): { goal: TuneGoal; users?: number; perUserContext?: number } {
  if (req.tune?.goal !== 'multi') return { goal: 'single' };
  return { goal: 'multi', users: req.tune.users ?? TUNE_MULTI_DEFAULTS.users, perUserContext: req.tune.perUserContext ?? TUNE_MULTI_DEFAULTS.perUserContext };
}

const sameGpu = (r: RunSummary, here: Pick<HereIdentity, 'gpuUuid' | 'gpuName'>): boolean =>
  here.gpuUuid && r.gpuUuid ? r.gpuUuid === here.gpuUuid : here.gpuName !== undefined && r.gpuName === here.gpuName;

/** The searched values of a combination: its own record, else read back from its launch parameters. */
function variantOf(c: Tuning['combinations'][number], kind: EngineKind): Record<string, DimValue> {
  if (c.variant) return c.variant;
  const p = c.params;
  if (!isLlamaCpp(kind)) return p.batchSize !== undefined ? { bt: p.batchSize } : {};
  return { ...(p.ubatchSize !== undefined ? { ub: p.ubatchSize } : {}), ...(p.batchSize !== undefined ? { b: p.batchSize } : {}) };
}

/**
 * Values that won in earlier tune runs on this GPU with this engine kind (any model): the recommended
 * combination's ubatch / batch (vLLM: batched tokens) of up to LEARNED_RUNS runs, the most frequent
 * first (then the most recent). Ordering only: the search still tries every value.
 */
export async function learnedOrder(
  runs: Pick<RunsRepo, 'list' | 'get'>,
  here: HereIdentity,
  kind: EngineKind,
): Promise<{ prefer: Record<string, DimValue[]>; learned: NonNullable<Tuning['learned']> } | undefined> {
  const keys = isLlamaCpp(kind) ? ['ub', 'b'] : ['bt'];
  const past = (await runs.list())
    .filter((r) => r.profile === 'tune' && r.status === 'completed' && Number(r.tunedCombinations) > 0 && r.tuneBudget !== 'recheck' && r.engineKind === kind && sameGpu(r, here))
    .slice(0, LEARNED_RUNS);
  const counts = new Map<string, Map<DimValue, number>>(keys.map((k) => [k, new Map()]));
  let used = 0;
  for (const r of past) {
    const t = (await runs.get(r.id).catch(() => undefined))?.tuning;
    const combo = t?.recommended !== undefined ? t.combinations[t.recommended] : undefined;
    if (!combo) continue;
    used++;
    const v = variantOf(combo, kind);
    for (const k of keys) {
      const value = v[k];
      if (value === undefined) continue;
      const m = counts.get(k) as Map<DimValue, number>;
      m.set(value, (m.get(value) ?? 0) + 1);
    }
  }
  if (used === 0) return undefined;
  const prefer: Record<string, DimValue[]> = {};
  const first: NonNullable<Tuning['learned']>['first'] = [];
  for (const k of keys) {
    // Stable sort: equal counts keep the order of the first (newest) run that had them.
    const values = [...(counts.get(k) as Map<DimValue, number>).entries()].sort((a, b) => b[1] - a[1]).map(([v]) => v);
    if (!values.length) continue;
    prefer[k] = values;
    first.push({ key: k, value: values[0] as DimValue });
  }
  return { prefer, learned: { runs: used, first } };
}

/** Everything the tuner needs for this request, measured now (free VRAM, platform, the build's flags, past runs). */
export async function buildTuneSetup(
  deps: TuneSetupDeps,
  req: Pick<StartRunRequest, 'tune' | 'engine'>,
  p: TunePrepared,
  recheck?: RecheckInput,
): Promise<TunerInput> {
  const kind = req.engine.kind;
  const budget = req.tune?.budget ?? 'fast';
  const goal = tuneGoalOf(req);
  const users = goal.users;
  const g = (await deps.telemetry.snapshot().catch(() => []))[0];
  const gpu = g?.memTotalMiB && g.memUsedMiB !== null ? { totalMiB: g.memTotalMiB, freeMiB: g.memTotalMiB - g.memUsedMiB } : undefined;
  const os = (await deps.fingerprint().catch(() => undefined))?.os;
  const facts = p.model.identity.facts;
  const fileBytes = p.launch.modelBytes > 0 ? p.launch.modelBytes : p.model.identity.sizeBytes;
  const step = p.scenario.steps.find((s) => s.kind === 'context-sweep');
  const calibration = await deps.calibration?.(p.model, kind).catch(() => undefined);
  const here = await deps.here?.().catch(() => undefined);
  const past = budget !== 'recheck' && deps.runs && here ? await learnedOrder(deps.runs, here, kind).catch(() => undefined) : undefined;
  const common = {
    budget,
    sweep: step ? { outputTokens: step.outputTokens, reps: step.reps } : DEFAULT_SWEEP,
    ...(facts?.contextLength !== undefined ? { modelContext: facts.contextLength } : {}),
    ...(gpu && facts
      ? { predict: (params: LaunchParams) => estimateFit({ facts, ...(fileBytes ? { fileBytes } : {}), gpu, engine: kind, params: fitParamsFrom(params), ...(calibration ? { calibration } : {}) }) }
      : {}),
    // A model that does not fit spills to shared memory under WDDM (Windows, and WSL which uses it).
    spillPossible: os !== undefined && (os.platform === 'win32' || os.isWsl),
    fidelity: req.tune?.fidelity ?? false,
    ...(users !== undefined ? { goal: 'multi' as const, multi: { users, perUserContext: goal.perUserContext as number, turns: MULTI_TURNS } } : {}),
    ...(past ? { learned: past.learned } : {}),
    ...(recheck ? { recheck } : {}),
  };
  const caps = await p.adapter.capabilities(p.engine).catch(() => undefined);
  const prefer = past?.prefer;
  if (!isLlamaCpp(kind)) {
    const util = vllmTuneUtilization(gpu);
    const space = vllmSpace({
      budget,
      params: p.params,
      ...(util !== undefined ? { utilizations: vllmUtilizations(util) } : {}),
      ...(users !== undefined ? { users } : {}),
      ...(caps ? { flags: caps.flags, ...(caps.choices ? { choices: caps.choices } : {}) } : {}),
      ...(prefer ? { prefer } : {}),
    });
    return { ...common, space };
  }
  const llama = caps as LlamaCaps | undefined;
  const draftArgs = llama?.entries && users === undefined ? speculativeArgs(p.model.local, llama) : undefined;
  const layers = facts?.blockCount;
  return {
    ...common,
    space: llamaSpace({
      budget,
      params: p.params,
      ...(draftArgs ? { draftArgs } : {}),
      ...(users !== undefined ? { users } : {}),
      ...(llama ? { flags: llama.flags } : {}),
      ...(prefer ? { prefer } : {}),
    }),
    // The last resort of goal 'single' only: several users each with their own context and part of the model on the CPU is not a configuration to recommend.
    ...(layers && users === undefined ? { offload: { layers, moe: (facts?.expertCount ?? 0) > 1 && llama?.flags.has('--n-cpu-moe') === true } } : {}),
  };
}

const family = (kind: EngineKind): 'llamacpp' | 'vllm' | 'external' => (kind === 'external' ? 'external' : isLlamaCpp(kind) ? 'llamacpp' : 'vllm');

/** What a tune run must match to stand for "the same question": goal, and for 'multi' the users and context per user. */
export interface TuneQuestion {
  goal: TuneGoal;
  users?: number | undefined;
  perUserContext?: number | undefined;
}

/**
 * Completed tune runs of this model on this PC and card, with the same engine family and the same
 * question, newest first (the summaries come from RunsRepo.tried, already newest first in each group).
 * With `measured` false, runs that measured no combination are kept too (a recheck that no longer fits).
 */
export function tuneRunsFor(runs: readonly RunSummary[], here: HereIdentity, kind: EngineKind, q: TuneQuestion = { goal: 'single' }, measured = true): RunSummary[] {
  return runs.filter(
    (r) =>
      r.profile === 'tune' &&
      r.status === 'completed' &&
      (!measured || (r.tunedCombinations ?? 0) > 0) &&
      r.hostId === here.hostId &&
      (!here.gpuUuid || !r.gpuUuid || r.gpuUuid === here.gpuUuid) &&
      family(r.engineKind) === family(kind) &&
      (r.tuneGoal ?? 'single') === q.goal &&
      (q.users === undefined || r.tuneUsers === q.users) &&
      (q.perUserContext === undefined || r.tunePerUserContext === q.perUserContext),
  );
}

/** The latest of tuneRunsFor. */
export function latestTuneRun(runs: readonly RunSummary[], here: HereIdentity, kind: EngineKind, q?: TuneQuestion): RunSummary | undefined {
  return tuneRunsFor(runs, here, kind, q)[0];
}

/**
 * The tune run a "Ricontrollo rapido" re-checks: the one asked for, else the latest with the same
 * question. Undefined when there is none, or it has no recommendation to re-check.
 */
export async function recheckSource(
  runs: Pick<RunsRepo, 'tried' | 'get'>,
  here: HereIdentity,
  req: Pick<StartRunRequest, 'tune' | 'engine'>,
  model: ModelTarget,
): Promise<RunResult | undefined> {
  const id = model.identity;
  let runId = req.tune?.recheckOf;
  if (runId === undefined) {
    const list = await runs.tried({ ...(id.sha256 ? { sha256: id.sha256 } : {}), weakKey: id.weakKey }, here).catch(() => []);
    runId = latestTuneRun(list, here, req.engine.kind, tuneGoalOf(req))?.id;
  }
  const run = runId !== undefined ? await runs.get(runId).catch(() => undefined) : undefined;
  return run?.scenario.profile === 'tune' && run.tuning?.recommended !== undefined ? run : undefined;
}

/** What to load again: the previous recommendation, then its runner-up. */
export function recheckInputOf(run: RunResult, currentBuild: string | undefined): RecheckInput {
  const t = run.tuning as Tuning;
  const second = runnerUp(t);
  const previousBuild = engineBuildOf(run.engine);
  return {
    previousRunId: run.id,
    previousCreatedAt: run.createdAt,
    ...(previousBuild !== undefined ? { previousBuild } : {}),
    ...(currentBuild !== undefined ? { currentBuild } : {}),
    ...(t.multi ? { multi: t.multi } : {}),
    checks: [
      { role: 'recommended', combination: t.combinations[t.recommended as number] as Tuning['combinations'][number] },
      ...(second !== undefined ? [{ role: 'runner-up' as const, combination: t.combinations[second] as Tuning['combinations'][number] }] : []),
    ],
  };
}

export interface TunedServer {
  params: LaunchParams;
  tuned: NonNullable<ServerPlan['tuned']>;
}

/**
 * "Avvia solo il server" when the user left the context unset: the recommended combination of the
 * latest "Trova le impostazioni migliori" of this model here (context, KV cache, flash attention,
 * batch…), with the same engine build or image when there is one (else the latest, marked
 * `otherBuild`). Several slots asked (params.parallel > 1): a "Più utenti" run for that many users.
 * Whatever the user did set wins. Undefined when there is no such run.
 */
export async function tunedServerParams(
  runs: Pick<RunsRepo, 'tried' | 'get'>,
  here: HereIdentity,
  req: StartServerRequest,
  model: ModelTarget,
  /** The engine build / image the server would use (asked only when there is a tune run to compare with). */
  currentBuildOf?: () => Promise<string | undefined>,
): Promise<TunedServer | undefined> {
  const id = model.identity;
  const user = req.params;
  const slots = user?.parallel ?? 1;
  const question: TuneQuestion = slots > 1 ? { goal: 'multi', users: slots } : { goal: 'single' };
  const list = tuneRunsFor(await runs.tried({ ...(id.sha256 ? { sha256: id.sha256 } : {}), weakKey: id.weakKey }, here).catch(() => []), here, req.engine.kind, question, false);
  const currentBuild = list.length && currentBuildOf ? await currentBuildOf().catch(() => undefined) : undefined;
  // The newest run with this build decides, even when it found nothing that fits (then: the estimate).
  const sameBuild = currentBuild !== undefined ? list.find((r) => r.engineBuild === currentBuild) : undefined;
  const hit = sameBuild ?? list.find((r) => Number(r.tunedCombinations) > 0);
  const run = hit ? await runs.get(hit.id).catch(() => undefined) : undefined;
  const t = run?.tuning;
  const combo = t?.recommended !== undefined ? t.combinations[t.recommended] : undefined;
  if (!run || !t || !combo) return undefined;
  const params: LaunchParams = { ...combo.params };
  if (user) {
    for (const [k, v] of Object.entries(user) as [keyof LaunchParams, unknown][]) {
      if (k === 'extraArgs' || k === 'env' || v === undefined) continue;
      (params as Record<string, unknown>)[k] = v;
    }
    if (user.extraArgs.length) params.extraArgs = user.extraArgs;
    params.env = { ...combo.params.env, ...user.env };
  }
  const build = engineBuildOf(run.engine);
  const other = !sameBuild && currentBuild !== undefined && build !== undefined && build !== currentBuild;
  const users = usersOf(t);
  return {
    params,
    tuned: {
      runId: run.id,
      createdAt: run.createdAt,
      contextSize: combo.maxContext,
      kvCacheType: combo.kvType,
      ...(t.goal ? { goal: t.goal } : {}),
      ...(users !== undefined ? { users } : {}),
      ...(other ? { otherBuild: { build, current: currentBuild } } : {}),
    },
  };
}
