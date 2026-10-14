/**
 * "Ricontrollo rapido" (budget 'recheck'): the engine build or image changed since the last tune of
 * this model here. Instead of a whole search, the previous recommended combination and its runner-up
 * are loaded again exactly as they were, at their largest context:
 *  - does that context still load fully on the GPU (no out of memory, no spill)?
 *  - a short sweep (the deepest prompt first, then 1K and the middle; goal 'multi': users 1 … N)
 *    compared with the previous numbers, noise-aware (tune-rank.ts).
 * Nothing is chosen anew: the recommendation stays the previous one (measured again) when it still
 * fits, and `suggestFull` says when a full search should be run instead (numbers moved, or it does
 * not fit any more).
 */
import type { ConcurrencyPoint, LatencyPoint, TuneCombination, TuneRecheck, Tuning } from '../../contract/results';
import { movedLevels, movedPoints, usersWithoutErrors } from './tune-rank';
import { PROBE_DEPTH, PROBE_OUTPUT, screenDepths, Tuner, type LabEngine, type Live, type TunerDeps, type TunerInput } from './tuner';

type Check = TuneRecheck['checks'][number];

/** The most users a combination was measured with (goal 'multi'); undefined for goal 'single'. */
export function usersMeasured(c: Pick<TuneCombination, 'concurrency'>): number | undefined {
  const levels = (c.concurrency ?? []).map((p) => p.level);
  return levels.length ? Math.max(...levels) : undefined;
}

/** The overall answer from the checks (see TuneRecheck.result). */
export function recheckResult(checks: readonly Check[]): TuneRecheck['result'] {
  const rec = checks.find((c) => c.role === 'recommended');
  if (!rec?.outcome || rec.outcome === 'error') return 'incomplete';
  if (!rec.fits) return 'no-longer-fits';
  const changed = checks.some((c) => c.moved.length > 0 || c.outcome === 'oom' || c.outcome === 'spill');
  return changed ? 'changed' : 'same';
}

export class RecheckTuner extends Tuner {
  private readonly checks: Check[] = [];
  /** The previous combination being loaded again. */
  private previous: TuneCombination | undefined;

  constructor(input: TunerInput, deps: TunerDeps) {
    super(input, deps);
  }

  private get recheck(): NonNullable<TunerInput['recheck']> {
    return this.input.recheck as NonNullable<TunerInput['recheck']>;
  }

  /** Nothing is predicted: the previous combinations are loaded as they were. */
  protected override predict(): void {}

  /** Expected ms of the re-checks not made yet: a load and a short sweep (goal 'multi': users 1 … N) each. */
  protected override plannedMs(): number {
    const todo = this.recheck.checks.slice(this.checks.length + (this.previous ? 1 : 0));
    return todo.reduce((ms, { combination: c }) => ms + this.checkMs(c), 0);
  }

  /** One re-check: its launch and 1K probe, then its measurements. */
  private checkMs(c: TuneCombination): number {
    return this.loadMs() + this.requestMs(PROBE_DEPTH, PROBE_OUTPUT) + this.measuresMs(c);
  }

  /** The measurements of one re-check: the short sweep, or users 1 … N with prompts of its context (prompts read one after the other). */
  private measuresMs(c: TuneCombination): number {
    const out = this.input.sweep.outputTokens;
    const users = usersMeasured(c);
    if (!users) return screenDepths(c.maxContext, out).reduce((ms, d) => ms + this.repsFor(d, this.rules.screenReps) * this.requestMs(d), 0);
    let ms = 0;
    for (let n = 1; n <= users; n++) ms += n * this.requestMs(c.maxContext / users, out);
    return ms;
  }

  /** The re-check being loaded still has its measurements to make (plannedMs counts the ones after it). */
  protected override currentWorkMs(): number {
    // Set before every launch.
    return this.measuresMs(this.previous as TuneCombination);
  }

  override async run(): Promise<Tuning> {
    this.prepare();
    this.deps.onPhase?.('tune-capacity');
    for (const { role, combination: previous } of this.recheck.checks) {
      const users = usersMeasured(previous);
      this.previous = previous;
      const live = await this.launch('recheck', previous.variant ?? { kv: previous.kvType }, previous.maxContext, (e, l) => (users ? this.usersWork(e, l, users) : this.shortSweep(e, l)), previous.params);
      const check: Check = { role, previous, fits: false, ...(live ? { outcome: live.att.outcome } : {}), moved: [] };
      if (live?.sweep || live?.users) {
        check.fits = true;
        check.combination = this.combos.length;
        check.moved = live.users ? movedLevels(previous.concurrency as ConcurrencyPoint[], live.users.concurrency) : movedPoints(previous.sweep, live.sweep as LatencyPoint[]);
        this.addCombination(live);
      }
      this.checks.push(check);
      this.update();
    }
    return this.snapshot();
  }

  /** The deepest prompt of the combination's context (the context full), then 1K and the middle. */
  private shortSweep(engine: LabEngine, live: Live): Promise<void> {
    return this.sweepWork(engine, live, [], screenDepths);
  }

  /** Users 1 … N in this order, one request each. */
  private async usersWork(engine: LabEngine, live: Live, users: number): Promise<void> {
    this.deps.onPhase?.('concurrency');
    // The same prompts as before (every point of a level says its prompt and answer length).
    const first = (this.previous as TuneCombination).concurrency?.[0] as ConcurrencyPoint;
    const promptTokens = first.promptTokens ?? this.recheck.multi?.promptTokens ?? live.att.contextSize;
    const outputTokens = first.outputTokens ?? this.input.sweep.outputTokens;
    const points: ConcurrencyPoint[] = [];
    for (let n = 1; n <= users; n++) points.push(await engine.concurrency(n, promptTokens, outputTokens, 1));
    live.att.concurrency = points;
    live.users = { concurrency: points, sessions: [] };
  }

  protected override combinationExtras(live: Live): Partial<TuneCombination> {
    if (!live.users) return {};
    const previous = this.previous as TuneCombination;
    return {
      concurrency: live.users.concurrency,
      sessions: [],
      usersWithoutErrors: usersWithoutErrors(live.users.concurrency),
      ...(previous.kvLayout ? { kvLayout: previous.kvLayout } : {}),
      ...(previous.cacheReuse ? { cacheReuse: previous.cacheReuse } : {}),
    };
  }

  protected override recommend(): number | undefined {
    return this.checks.find((c) => c.role === 'recommended' && c.fits)?.combination;
  }

  protected override goalFields(): Partial<Tuning> {
    const r = this.recheck;
    const result = recheckResult(this.checks);
    return {
      ...(r.multi ? { goal: 'multi' as const, multi: r.multi } : {}),
      dimensions: [],
      recheck: {
        previousRunId: r.previousRunId,
        previousCreatedAt: r.previousCreatedAt,
        ...(r.previousBuild !== undefined ? { previousBuild: r.previousBuild } : {}),
        ...(r.currentBuild !== undefined ? { currentBuild: r.currentBuild } : {}),
        checks: this.checks.map((c) => ({ ...c, moved: [...c.moved] })),
        result,
        suggestFull: result !== 'same',
      },
    };
  }
}
