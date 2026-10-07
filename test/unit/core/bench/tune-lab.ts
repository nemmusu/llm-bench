/**
 * A deterministic machine for the tuner's searches: the fake engine's own memory and speed models
 * (test/fakes/fake-engine/server.mjs memoryPlan/speeds), virtual time, no processes.
 */
import { launchParamsSchema, type LaunchParams } from '../../../../src/contract/engines';
import type { AppErrorData } from '../../../../src/contract/errors';
import type { FitEstimate } from '../../../../src/contract/models';
import type { TuneAttempt, Tuning } from '../../../../src/contract/results';
import { createTuner } from '../../../../src/core/bench/tune-run';
import { llamaSpace } from '../../../../src/core/bench/tune-space';
import type { LabEngine, LabLaunch, LabStart, TuneLab, TunerInput } from '../../../../src/core/bench/tuner';
import { memoryPlan, speeds, type FakeProfile } from '../../../fakes/fake-engine/server.mjs';
import { TUNE_PROFILE } from '../../../fakes/fake-engine/profiles.mjs';
import { concurrencyPoint, point, sessionsPoint } from './tune-helpers';

export const P = (over: Partial<LaunchParams> = {}): LaunchParams => launchParamsSchema.parse(over);

export interface LabOptions {
  profile?: FakeProfile;
  flavor?: 'llamacpp' | 'vllm';
  loadMs?: number;
  requestMs?: number;
  /** Shared GPU memory reported for a launch (Windows counters); `requests` = requests measured so far on it. */
  shared?: (p: LaunchParams, requests: number) => number | undefined;
  /** Start failures by launch number (1-based). */
  fail?: (p: LaunchParams, n: number) => AppErrorData | undefined;
  /** A request that throws (engine died, cancelled…). */
  throwOn?: (p: LaunchParams, depth: number) => Error | undefined;
  /** Greedy tokens of a launch (fidelity). */
  tokens?: (p: LaunchParams) => (number | string)[];
  /** Spilled engines are this much slower on deep prompts only (the KV tail is in system RAM). */
  deepSpillOnly?: boolean;
  /** Replaces the generation speed of some requests. */
  decode?: (p: LaunchParams, depth: number) => number | undefined;
  noVram?: boolean;
  /** Users at once: failed requests of a level, and the later messages' TTFT of the conversations. */
  usersErrors?: (p: LaunchParams, level: number) => number;
  laterTtft?: (p: LaunchParams) => number;
  /** The conversations step measures nothing (a context too small for them). */
  noSessions?: boolean;
}

const argOf = (p: LaunchParams, flag: string): string | undefined => {
  const i = p.extraArgs.indexOf(flag);
  return i >= 0 ? p.extraArgs[i + 1] : undefined;
};
const graphsOf = (p: LaunchParams): number[] | undefined => {
  const i = p.extraArgs.indexOf('--cuda-graph-sizes');
  if (i < 0) return undefined;
  const out: number[] = [];
  for (let k = i + 1; k < p.extraArgs.length && !p.extraArgs[k]!.startsWith('-'); k++) out.push(Number(p.extraArgs[k]));
  return out;
};

/** Linux-like: beyond the VRAM a load fails (no spill). */
export const LINUX: FakeProfile = { ...TUNE_PROFILE, memory: { ...TUNE_PROFILE.memory!, spillMiB: 0 } };

/** A machine that answers like the fake engine's models, on a virtual clock. */
export class Lab implements TuneLab {
  t = 0;
  readonly started: LaunchParams[] = [];
  readonly stopped: number[] = [];
  constructor(private readonly o: LabOptions = {}) {}
  now = (): number => this.t;

  async prepare(params: LaunchParams): Promise<LabLaunch> {
    const o = this.o;
    const argv = ['engine', JSON.stringify({ c: params.contextSize ?? params.maxModelLen, kv: params.kvCacheType, fa: params.flashAttention, ub: params.ubatchSize, b: params.batchSize, x: params.extraArgs })];
    return {
      command: { argv, powershell: argv.join(' '), bash: argv.join(' ') },
      start: async (): Promise<LabStart> => {
        this.started.push(params);
        const n = this.started.length;
        this.t += o.loadMs ?? 1000;
        const fail = o.fail?.(params, n);
        if (fail) return { ok: false, error: fail, loadMs: 10 };
        const profile = o.profile ?? LINUX;
        const flavor = o.flavor ?? 'llamacpp';
        const ctx = (params.contextSize ?? params.maxModelLen) as number;
        const ncmoe = argOf(params, '--n-cpu-moe');
        const block = argOf(params, '--block-size');
        const graphs = graphsOf(params);
        const plan = memoryPlan(profile.memory!, {
          flavor,
          ctx,
          kvType: params.kvCacheType,
          ubatch: params.ubatchSize ?? params.batchSize,
          ...(ncmoe !== undefined ? { nCpuMoe: Number(ncmoe) } : {}),
          ...(params.gpuLayers !== undefined ? { gpuLayers: params.gpuLayers } : {}),
          ...(params.gpuMemoryUtilization !== undefined ? { gpuMemoryUtilization: params.gpuMemoryUtilization } : {}),
          eager: params.extraArgs.includes('--enforce-eager'),
          ...(block !== undefined ? { blockSize: Number(block) } : {}),
          ...(graphs ? { graphSizes: graphs } : {}),
        });
        if (plan.outcome === 'busy') {
          const util = params.gpuMemoryUtilization ?? 0.9;
          return { ok: false, error: { code: 'VRAM_BUSY', message: 'Not enough free VRAM for the requested GPU memory utilization', params: { utilization: util } } };
        }
        if (plan.outcome === 'oom') return { ok: false, error: { code: 'ENGINE_OOM', message: 'cudaMalloc failed: out of memory' } };
        if (plan.outcome === 'kv-too-small') {
          return { ok: false, error: { code: 'MODEL_TOO_LARGE', message: 'kv', params: { reason: 'kv-cache', estimatedMaxModelLen: plan.capacity! } } };
        }
        const kvFormat = argOf(params, '--kv-cache-dtype');
        const rates = (depth: number, extra: { spill?: boolean; unified?: boolean } = {}) =>
          speeds(profile, {
            depth,
            flashAttn: params.flashAttention,
            kvType: params.kvCacheType,
            ...(kvFormat !== undefined ? { kvFormat } : {}),
            ubatch: params.ubatchSize ?? params.batchSize,
            spill: extra.spill ?? plan.outcome === 'spill',
            cpuShare: plan.cpuShare,
            unified: extra.unified ?? false,
            ...(block !== undefined ? { blockSize: Number(block) } : {}),
          });
        let requests = 0;
        const engine: LabEngine = {
          measure: async (depth) => {
            const err = o.throwOn?.(params, depth);
            if (err) throw err;
            requests++;
            this.t += o.requestMs ?? 500;
            const s = rates(depth, { spill: plan.outcome === 'spill' && (!o.deepSpillOnly || depth > 8192) });
            return point(depth, o.decode?.(params, depth) ?? s.decode, { prefill: s.prefill });
          },
          memory: () => {
            const shared = o.shared?.(params, requests);
            return { ...(o.noVram ? {} : { vramPeakMiB: plan.vramMiB }), ...(shared !== undefined ? { sharedPeakMiB: shared } : {}) };
          },
          concurrency: async (level, promptTokens, outputTokens) => {
            requests += level;
            this.t += (o.requestMs ?? 500) * level;
            const unified = flavor === 'llamacpp' && params.parallel !== undefined && params.parallel > 1 && !params.extraArgs.includes('--no-kv-unified');
            const s = rates(promptTokens, { unified });
            // Like the fake engine: every extra user busy at once slows each one by 15 %; prompts are read one at a time.
            const perUser = (o.decode?.(params, promptTokens) ?? s.decode) / (1 + 0.15 * (level - 1));
            const read = (promptTokens / s.prefill) * 1000;
            return concurrencyPoint(level, perUser, { promptTokens, outputTokens, ttftP95: read * level, errors: o.usersErrors?.(params, level) ?? 0 });
          },
          sessions: async (step) => {
            this.t += o.requestMs ?? 500;
            return o.noSessions ? [] : [sessionsPoint(step.levels[0] as number, step.depth, o.laterTtft?.(params) ?? 100)];
          },
          capacityHint: () => plan.capacity,
          generate: async () => o.tokens?.(params) ?? [1, 2, 3, 4],
          stop: async () => {
            this.stopped.push(n);
          },
        };
        return { ok: true, engine, loadMs: o.loadMs ?? 1000 };
      },
    };
  }
}

/** The VRAM estimate as optimistic as the real one can be (everything fits up to the trained context). */
export const optimistic = (): FitEstimate => ({ level: 'good', needMiB: 1000, weightsMiB: 500, kvMiB: 400, overheadMiB: 100, availableMiB: 30000, utilization: 0.03, contextSize: 1, basis: 'file-size', notes: [] });

export function input(over: Partial<TunerInput> = {}): TunerInput {
  return {
    space: llamaSpace({ budget: 'fast', params: P() }),
    budget: 'fast',
    sweep: { outputTokens: 128, reps: 2 },
    modelContext: 40960,
    predict: optimistic,
    spillPossible: false,
    fidelity: false,
    ...over,
  };
}

export async function tune(over: Partial<TunerInput> = {}, lab = new Lab()): Promise<{ t: Tuning; lab: Lab; updates: { t: Tuning; current?: unknown }[]; phases: string[] }> {
  const updates: { t: Tuning; current?: unknown }[] = [];
  const phases: string[] = [];
  const t = await createTuner(input(over), { lab, now: lab.now, onUpdate: (x, current) => updates.push({ t: x, current }), onPhase: (p) => phases.push(p) }).run();
  return { t, lab, updates, phases };
}

export const capacityOf = (t: Tuning) => Object.fromEntries(t.capacity.map((c) => [c.kvType, c.measuredMax]));
export const brief = (a: TuneAttempt) => `${a.stage} ${a.kvType}@${a.contextSize} ${a.params.flashAttention ?? ''}/${a.params.ubatchSize ?? a.params.batchSize ?? ''} ${a.outcome}`;
