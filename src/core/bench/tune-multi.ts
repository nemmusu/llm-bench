/**
 * "Trova le impostazioni migliori", goal 'multi' ("Più utenti"): N users at once, each with its own
 * context of C tokens. The context is fixed by the request (llama.cpp -c N × C with -np N; vLLM
 * --max-model-len C with --max-num-seqs N and a KV pool of at least N × C), so the search is about
 * speed with everyone busy:
 *
 *  1. Capacity: per KV type (most precise first) one launch at that context; it holds N users when it
 *     loads without running out of memory or spilling (vLLM: its KV pool holds N × C tokens). A less
 *     precise type is known to hold them when a more precise one does. When none does, the most users
 *     that fit with the most compact KV are searched (binary search) and measured instead.
 *  2. Coordinate descent per fitting KV type (llama.cpp: pool split per user or shared, --cache-reuse,
 *     flash attention, ubatch, batch; vLLM: batched tokens, block size, fp8 format): each value is
 *     screened with N users at once (one request each, prompts of C − answer − margin tokens) plus N
 *     short conversations (3 messages, prefix cache on), and kept when it serves the users better
 *     (tune-rank.ts compareUsers: fewer failed requests → per-user generation p50 → total tok/s →
 *     TTFT p95 → later messages' TTFT).
 *  3. Full measurement of each type's best: users 1, 2, … N in this order (middle levels are skipped
 *     only when the time budget is short; N is always measured) and the conversations.
 *  4. Recommended: the combination that serves N users best (then the more precise KV).
 */
import type { AppErrorData } from '../../contract/errors';
import type { ConcurrencyPoint, SessionsPoint, SessionsStep, TuneCombination, TuneKvType, Tuning } from '../../contract/results';
import { sessionExtras } from './scenarios';
import { maxDepth } from './sweep';
import { compareUsers, recommendedForUsers, usersWithoutErrors, type UsersMeasure } from './tune-rank';
import { lastToTry, MIN_SWEEP_MS, PROBE_DEPTH, PROBE_OUTPUT, Tuner, type Capacity, type DimValue, type Dimension, type LabEngine, type Live, type TunerDeps, type TunerInput, type Variant } from './tuner';

/** Messages per conversation and new text of every later message, in the short conversations. */
export const MULTI_TURNS = 3;
export const MULTI_FOLLOWUP = 256;
/** The reference launch (spill detection) gives every user this much context. */
export const MULTI_REFERENCE_CONTEXT = 1024;

/** One screened configuration of goal 'multi'. */
interface UsersScreen {
  variant: Variant;
  ctx: number;
  attempt: number;
  measure: UsersMeasure;
  /** ms the users level took (it sizes the full measurement against the time budget). */
  levelMs: number;
}

/** A launch whose KV pool cannot hold every user's context (vLLM reports its pool). */
export function poolTooSmall(kvTokens: number, needTokens: number): AppErrorData {
  return { code: 'MODEL_TOO_LARGE', message: 'The KV cache holds fewer tokens than the users need', params: { reason: 'kv-cache', kvTokens, needTokens } };
}

export class MultiTuner extends Tuner {
  /** Users measured: those asked, or the most that fit. */
  private users: number;
  private readonly asked: number;
  /** Context per user (at most the model's trained context). */
  private readonly perUser: number;
  /** Messages per conversation of the sessions measurement. */
  private readonly turns: number;
  private fittingUsers: number | undefined;
  private readonly usersScreens = new Map<string, UsersScreen>();

  constructor(input: TunerInput, deps: TunerDeps) {
    super(input, deps);
    const m = input.multi as NonNullable<TunerInput['multi']>;
    this.asked = m.users;
    this.users = m.users;
    this.perUser = Math.min(m.perUserContext, this.cap);
    this.turns = m.turns;
  }

  private get out(): number {
    return this.input.sweep.outputTokens;
  }

  /** Prompt of every concurrent request: the user's whole context but the answer and the margin. */
  private get prompt(): number {
    return maxDepth(this.perUser, this.out);
  }

  /** The short conversations of `users` users: each fills its own context over MULTI_TURNS messages. */
  sessionsStep(users: number): SessionsStep | undefined {
    const step = { kind: 'sessions' as const, depth: 0, levels: [users], turns: this.turns, followupTokens: MULTI_FOLLOWUP, outputTokens: this.out };
    const depth = this.perUser - sessionExtras(step);
    return depth >= 1 ? { ...step, depth } : undefined;
  }

  private contextFor(users: number): number {
    return this.input.space.contextFor(users, this.perUser);
  }

  protected override base(kv: TuneKvType): Variant {
    return { ...super.base(kv), np: this.users };
  }

  /** Each KV type holds the users or not: one candidate, the context of N users. */
  protected override predict(): void {
    const { space } = this.input;
    const ctx = this.contextFor(this.users);
    for (const kv of space.kvLadder) {
      const fits = this.predictFits(space.params(this.base(kv), ctx));
      this.capacity.set(kv, { kv, ...(fits === true ? { predictedMax: ctx } : {}), candidates: fits === false ? [] : [ctx], status: new Map(), launched: new Set(), inferred: false });
    }
  }

  override async run(): Promise<Tuning> {
    this.prepare();
    const { space } = this.input;
    const ctx = this.contextFor(this.users);
    this.deps.onPhase?.('tune-capacity');
    if (this.input.spillPossible) await this.reference(space.contextFor(this.users, Math.min(this.perUser, MULTI_REFERENCE_CONTEXT)));
    for (const kv of space.kvLadder) {
      await this.holdsUsers(kv, ctx);
      this.capacityEnded.add(kv);
    }
    let fitting = space.kvLadder.filter((kv) => this.capacity.get(kv)?.measuredMax !== undefined);
    if (fitting.length === 0) fitting = await this.mostUsers();
    for (const kv of fitting) {
      this.deps.onPhase?.('tune-variants');
      const best = await this.descendUsers(kv);
      this.descended.add(kv);
      this.descentLeft.delete(kv);
      if (best && !this.combined.has(this.key(best.variant, best.ctx))) {
        const live = await this.launch('sweep', best.variant, best.ctx, (e, l) => this.fullWork(e, l, best));
        if (live?.users) this.addCombination(live);
      }
      this.swept.add(kv);
    }
    return this.snapshot();
  }

  /** Expected ms of N users at once with `prompt` tokens each: prompts read one after the other, answers slowed 15 % per extra user. */
  private levelMs(users: number): number {
    const one = this.requestMs(this.prompt, this.out);
    const read = one - this.requestMs(0, this.out);
    return users * read + (one - read) * (1 + 0.15 * (users - 1));
  }

  /** Expected ms of the short conversations of N users (first messages read in full, later ones from the cache). */
  private sessionsMs(users: number): number {
    return this.levelMs(users) + (this.turns - 1) * this.requestMs(MULTI_FOLLOWUP, this.out) * users;
  }

  /**
   * Expected ms of the work not started yet (goal 'multi'): per KV type that holds the users (or is
   * expected to), its screenings with every user busy, then users 1 … N.
   */
  protected override plannedMs(): number {
    const load = this.loadMs();
    const screen = load + this.levelMs(this.users) + this.sessionsMs(this.users);
    let ms = this.input.spillPossible && !this.refDone ? load + this.requestMs(PROBE_DEPTH, PROBE_OUTPUT) : 0;
    let fitting = false;
    for (const kv of this.input.space.kvLadder) {
      const cap = this.capacity.get(kv) as Capacity;
      // A less precise type than one that holds the users holds them too; one being checked is expected to.
      const holds = this.capacityEnded.has(kv) ? cap.measuredMax !== undefined : fitting || cap.candidates.length > 0;
      if (!holds) continue;
      fitting = true;
      // A capacity launch already screened the base settings.
      const screens = this.descentLeft.get(kv) ?? this.screensOf(kv) - (cap.launched.size > 0 ? 1 : 0);
      if (!this.descended.has(kv)) ms += screens * screen;
      if (!this.swept.has(kv)) {
        ms += load;
        for (let n = 1; n <= this.users; n++) ms += this.levelMs(n);
      }
    }
    return ms;
  }

  /** Does this KV type hold every user's context? One launch, screened at once when it does. */
  private async holdsUsers(kv: TuneKvType, ctx: number): Promise<void> {
    const cap = this.capacity.get(kv) as Capacity;
    const ladder = this.input.space.kvLadder;
    if (this.bestPrecise(kv) !== undefined) {
      cap.measuredMax = ctx;
      cap.inferred = true;
      cap.skipped = 'no-gain';
      return;
    }
    if (cap.candidates.length === 0 && kv !== ladder[ladder.length - 1]) {
      cap.skipped = 'estimate';
      return;
    }
    const live = await this.launch('capacity', this.base(kv), ctx, (e, l) => this.usersWork(e, l));
    if (!live) {
      cap.skipped = 'budget';
      return;
    }
    cap.launched.add(ctx);
    cap.status.set(ctx, live.att.outcome === 'ok');
    if (live.att.outcome === 'ok') cap.measuredMax = ctx;
  }

  /**
   * Nothing holds N users: the most users (each with the whole context per user) that the most compact
   * KV type holds, by binary search; they are measured instead of N. Returns the fitting KV types.
   */
  private async mostUsers(): Promise<TuneKvType[]> {
    const ladder = this.input.space.kvLadder;
    const kv = ladder[ladder.length - 1] as TuneKvType;
    let lo = 0;
    let hi = this.users;
    while (hi - lo > 1) {
      const n = Math.floor((lo + hi) / 2);
      const live = await this.launch('capacity', { ...this.base(kv), np: n }, this.contextFor(n), (e, l) => this.usersWork(e, l));
      if (!live) break;
      if (live.att.outcome === 'ok') lo = n;
      else hi = n;
    }
    if (lo === 0) return [];
    this.fittingUsers = lo;
    this.users = lo;
    const cap = this.capacity.get(kv) as Capacity;
    cap.measuredMax = this.contextFor(lo);
    return [kv];
  }

  /** Users of a launch: its -np / --max-num-seqs. */
  private levelOf(live: Live): number {
    return live.variant.np as number;
  }

  /** Screening: every user at once with one request each, then the short conversations. */
  private async usersWork(engine: LabEngine, live: Live): Promise<void> {
    const att = live.att;
    const level = this.levelOf(live);
    const need = level * this.perUser;
    if (live.hint !== undefined && live.hint < need) {
      att.outcome = 'oom';
      att.error = poolTooSmall(live.hint, need);
      return;
    }
    const predicted = this.levelMs(level);
    // Every user at once would end past the time limit: not started (the search stops).
    if (!this.fitsInTime(predicted)) {
      att.skipped = [{ depth: this.prompt, predictedMs: Math.round(predicted) }];
      this.stoppedBy ??= 'budget';
      return;
    }
    const t0 = this.deps.now();
    this.busy(predicted);
    const point = await engine.concurrency(level, this.prompt, this.out, 1);
    this.settle();
    const levelMs = this.deps.now() - t0;
    att.concurrency = [...(att.concurrency ?? []), point];
    const step = this.sessionsStep(level);
    const sessions = step ? await engine.sessions(step) : [];
    if (sessions.length) att.sessions = [...(att.sessions ?? []), ...sessions];
    this.usersScreens.set(this.key(live.variant, att.contextSize), { variant: live.variant, ctx: att.contextSize, attempt: live.index, measure: { point, sessions: sessions[0] }, levelMs });
  }

  /**
   * Users 1 … N in this order (one request each), then the conversations (reused from this launch's
   * screening when there is one). A middle level is skipped when the rest of the budget would not
   * leave room for level N.
   */
  private async fullWork(engine: LabEngine, live: Live, screened: UsersScreen): Promise<void> {
    this.deps.onPhase?.('concurrency');
    const level = this.levelOf(live);
    const deadline = this.started + Math.max(this.limitMs, this.deps.now() - this.started + MIN_SWEEP_MS);
    const levelMs = screened.levelMs;
    const points: ConcurrencyPoint[] = [];
    for (let n = 1; n <= level; n++) {
      if (n < level && this.deps.now() + (levelMs * n) / level + levelMs > deadline) continue;
      points.push(await engine.concurrency(n, this.prompt, this.out, 1));
    }
    live.att.concurrency = [...(live.att.concurrency ?? []), ...points];
    let sessions: SessionsPoint[] = screened.measure.sessions && screened.attempt === live.index ? [screened.measure.sessions] : [];
    const step = this.sessionsStep(level);
    if (!sessions.length && step) {
      this.deps.onPhase?.('sessions');
      sessions = await engine.sessions(step);
      live.att.sessions = [...(live.att.sessions ?? []), ...sessions];
    }
    live.users = { concurrency: points, sessions };
  }

  /** The base settings of a fitting KV type screened with all users (launched if not yet). */
  private async baseUsers(kv: TuneKvType): Promise<UsersScreen | undefined> {
    this.screened(kv);
    const cap = this.capacity.get(kv) as Capacity;
    const base = this.base(kv);
    const ctx = cap.measuredMax as number;
    const known = this.usersScreens.get(this.key(base, ctx));
    if (known) return known;
    const live = await this.launch('variant', base, ctx, (e, l) => this.usersWork(e, l));
    if (live?.att.outcome !== 'ok') {
      if (live) delete cap.measuredMax;
      return undefined;
    }
    live.att.screen = 'kept';
    return this.usersScreens.get(this.key(base, ctx));
  }

  /** One screening of a KV type's descent is done (or skipped): the forecast counts one less. */
  private screened(kv: TuneKvType): void {
    // Set when the descent of this type started.
    this.descentLeft.set(kv, Math.max(0, (this.descentLeft.get(kv) as number) - 1));
  }

  /** One dimension at a time with every user busy; returns the best screened settings. */
  private async descendUsers(kv: TuneKvType): Promise<UsersScreen | undefined> {
    this.descentLeft.set(kv, this.screensOf(kv));
    let best = await this.baseUsers(kv);
    if (!best) return undefined;
    const dims = this.input.space.dimensions;
    for (let d = 0; d < dims.length; d++) {
      const dim = dims[d] as Dimension;
      const from: UsersScreen = best;
      const values = dim.values(from.variant).filter((v) => v !== from.variant[dim.key]);
      for (let i = 0; i < values.length; i++) {
        const current: UsersScreen = best;
        const variant: Variant = { ...current.variant, [dim.key]: values[i] as DimValue };
        this.screened(kv);
        if (dim.prune?.(values[i] as DimValue) && !this.estimateAllows(variant, current)) continue;
        const last = i === values.length - 1 && lastToTry(dims, d, variant);
        let won = false;
        const key = this.key(variant, current.ctx);
        const live = await this.launch('variant', variant, current.ctx, async (engine, l) => {
          await this.usersWork(engine, l);
          const mine = this.usersScreens.get(key);
          // Out of memory, or not measured (the time limit): nothing to compare.
          if (l.att.outcome !== 'ok' || !mine) return;
          won = compareUsers(mine.measure, current.measure) > 0;
          // The last value tried (no later dimension has another value for it), and the winner: users 1 … N on this same launch.
          if (won && last) await this.fullWork(engine, l, mine);
        });
        if (!live) return best;
        if (live.att.outcome !== 'ok' || !this.usersScreens.has(key)) continue;
        live.att.screen = won ? 'kept' : 'lost';
        if (!won) continue;
        this.attempts[current.attempt]!.screen = 'lost';
        best = this.usersScreens.get(this.key(variant, current.ctx)) as UsersScreen;
        if (live.users) this.addCombination(live);
      }
    }
    return best;
  }

  /** The context is the request's (N users × their context): there is no largest context to bound. */
  protected override boundOf(): Partial<Tuning['capacity'][number]> {
    return {};
  }

  /** Every combination of this goal measured its users: an unfinished screening is not one (nothing "misurata in parte"). */
  protected override addPartials(): void {}

  protected override forget(live: Live): void {
    super.forget(live);
    this.usersScreens.delete(this.key(live.variant, live.att.contextSize));
  }

  protected override combinationExtras(live: Live): Partial<TuneCombination> {
    const u = live.users as NonNullable<Live['users']>;
    const v = live.variant;
    return {
      concurrency: u.concurrency,
      sessions: u.sessions,
      usersWithoutErrors: usersWithoutErrors(u.concurrency),
      kvLayout: v.layout === 'split' ? 'split' : 'unified',
      ...(typeof v.reuse === 'number' && v.reuse > 0 ? { cacheReuse: v.reuse } : {}),
    };
  }

  protected override recommend(combos: readonly TuneCombination[]): number | undefined {
    return recommendedForUsers(combos, this.users);
  }

  protected override goalFields(): Partial<Tuning> {
    const turns = this.turns;
    return {
      goal: 'multi',
      multi: {
        users: this.asked,
        perUserContext: this.perUser,
        promptTokens: this.prompt,
        outputTokens: this.out,
        turns,
        ...(this.fittingUsers !== undefined ? { fittingUsers: this.fittingUsers } : {}),
      },
    };
  }
}

