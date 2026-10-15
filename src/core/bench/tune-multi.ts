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
 *     only when the time budget is short; N is always measured) and the conversations. "Solo N
 *     utenti insieme" (usersMode 'exact'): nothing more, the best's own screening (N users at once
 *     and the conversations) is its measurement: no lower level, no launch of its own.
 *  4. Recommended: the combination that serves N users best (then the more precise KV).
 *
 * "Massimo" (perUserContext 'max'): step 1 is the capacity search of goal 'single' (tuner.ts) on the
 * context of each user instead of the launch's: the VRAM estimate's candidates (powers of two from 4K,
 * the estimate itself, the model's context), the top one first, then a binary search and the steps of
 * 8K between the largest that loads and the smallest that does not; each candidate is launched for N
 * users of that context (llama.cpp -c N × it with -np N; vLLM / SGLang --max-model-len it and its KV
 * pool, NInfer --max-context it with --kv-capacity N × it, TensorRT-LLM max_seq_len it with
 * max_batch_size N, a program's {ctx} N × it with {parallel} N), and holds them when it loads without
 * running out of memory or spilling and its KV pool, when the engine says it, holds N × it tokens (the
 * pool an engine reports, divided among the users, is the next candidate). The screening with every user
 * busy then fills each user's whole context: when that runs out of memory or spills, the next candidate
 * down is screened instead. Steps 2–3 follow at each KV type's own context per user; the recommended
 * combination is the one with the largest context per user, then the one that serves N users best. When
 * not even 4K each holds N users, the most users with 4K each are searched, as above.
 */
import type { AppErrorData } from '../../contract/errors';
import type { ConcurrencyPoint, SessionsPoint, SessionsStep, TuneCombination, TuneKvType, Tuning } from '../../contract/results';
import { sessionExtras } from './scenarios';
import { maxDepth } from './sweep';
import { compareUsers, recommendedForUsers, usersWithoutErrors, type UsersMeasure } from './tune-rank';
import {
  CAPACITY_LAUNCHES,
  lastToTry,
  MIN_SWEEP_MS,
  PROBE_DEPTH,
  PROBE_OUTPUT,
  Tuner,
  type Capacity,
  type DimValue,
  type Dimension,
  type LabEngine,
  type Live,
  type TunerDeps,
  type TunerInput,
  type Variant,
  type Work,
} from './tuner';

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
  /** The screening's launch ("solo N utenti": it becomes the combination as it is). */
  live: Live;
}

/** A launch whose KV pool cannot hold every user's context (vLLM reports its pool). */
export function poolTooSmall(kvTokens: number, needTokens: number): AppErrorData {
  return { code: 'MODEL_TOO_LARGE', message: 'The KV cache holds fewer tokens than the users need', params: { reason: 'kv-cache', kvTokens, needTokens } };
}

export class MultiTuner extends Tuner {
  /** Users measured: those asked, or the most that fit. */
  private users: number;
  private readonly asked: number;
  /** Context per user asked (at most the model's trained context); undefined = "Massimo" (each KV type its own). */
  private readonly fixed: number | undefined;
  /** Messages per conversation of the sessions measurement. */
  private readonly turns: number;
  private fittingUsers: number | undefined;
  private readonly usersScreens = new Map<string, UsersScreen>();
  /** "Solo N utenti insieme": only N users at once are measured (no users 1 … N). */
  private readonly exact: boolean;

  constructor(input: TunerInput, deps: TunerDeps) {
    super(input, deps);
    const m = input.multi as NonNullable<TunerInput['multi']>;
    this.exact = m.usersMode === 'exact';
    this.asked = m.users;
    this.users = m.users;
    this.fixed = m.perUserContext === 'max' ? undefined : Math.min(m.perUserContext, this.cap);
    this.turns = m.turns;
  }

  /** "Massimo": the largest context per user is searched for each KV type. */
  private get largest(): boolean {
    return this.fixed === undefined;
  }

  private get out(): number {
    return this.input.sweep.outputTokens;
  }

  /** Prompt of every concurrent request: the user's whole context but the answer and the margin. */
  private promptOf(perUser: number): number {
    return maxDepth(perUser, this.out);
  }

  /** The short conversations of `users` users: each fills its own context of `perUser` tokens over MULTI_TURNS messages. */
  sessionsStep(users: number, perUser: number): SessionsStep | undefined {
    const step = { kind: 'sessions' as const, depth: 0, levels: [users], turns: this.turns, followupTokens: MULTI_FOLLOWUP, outputTokens: this.out };
    const depth = perUser - sessionExtras(step);
    return depth >= 1 ? { ...step, depth } : undefined;
  }

  /** The context of a launch for `users` users of `perUser` tokens each. */
  private contextFor(users: number, perUser: number): number {
    return this.input.space.contextFor(users, perUser);
  }

  /** Context per user of a launch: its context over what one user adds to it (llama.cpp: the users × it; vLLM: it). */
  private perUserOf(live: Live): number {
    return Math.floor(live.att.contextSize / this.contextFor(this.levelOf(live), 1));
  }

  /** "Massimo": a capacity candidate is a context per user, launched for every user. */
  protected override launchContext(c: number): number {
    return this.largest ? this.contextFor(this.users, c) : c;
  }

  /** "Massimo" (the only search of a context here): the KV pool an engine reports is shared by every user. */
  protected override hintContext(tokens: number): number {
    return Math.floor(tokens / this.users);
  }

  /** "Massimo" (the only search of a context here): a capacity launch holds the users only when its KV pool, if the engine says it, holds all of them. */
  protected override capacityWork(c: number): Work {
    return async (_engine, live) => {
      const need = this.users * c;
      if (live.hint !== undefined && live.hint < need) {
        live.att.outcome = 'oom';
        live.att.error = poolTooSmall(live.hint, need);
      }
    };
  }

  protected override base(kv: TuneKvType): Variant {
    return { ...super.base(kv), np: this.users };
  }

  /** Each KV type holds the users or not: one candidate, the context of N users ("Massimo": the candidates of goal 'single', per user). */
  protected override predict(): void {
    if (this.largest) return super.predict();
    const { space } = this.input;
    const ctx = this.contextFor(this.users, this.fixed as number);
    for (const kv of space.kvLadder) {
      const fits = this.predictFits(space.params(this.base(kv), ctx));
      this.capacity.set(kv, { kv, ...(fits === true ? { predictedMax: ctx } : {}), candidates: fits === false ? [] : [ctx], status: new Map(), launched: new Set(), inferred: false });
    }
  }

  override async run(): Promise<Tuning> {
    this.prepare();
    this.deps.onPhase?.('tune-capacity');
    const fitting = this.largest ? await this.largestPerUser() : await this.holdAll(this.fixed as number);
    for (const kv of fitting) {
      this.deps.onPhase?.('tune-variants');
      const best = await this.descendUsers(kv);
      this.descended.add(kv);
      this.descentLeft.delete(kv);
      if (best && !this.combined.has(this.key(best.variant, best.ctx))) {
        if (this.exact) this.combineScreen(best);
        else {
          const live = await this.launch('sweep', best.variant, best.ctx, (e, l) => this.fullWork(e, l, best));
          if (live?.users) this.addCombination(live);
        }
      }
      this.swept.add(kv);
    }
    return this.snapshot();
  }

  /** Every KV type at the context of N users of `perUser` tokens each; returns those that hold them (else the most users that fit). */
  private async holdAll(perUser: number): Promise<TuneKvType[]> {
    const { space } = this.input;
    const ctx = this.contextFor(this.users, perUser);
    if (this.input.spillPossible) await this.reference(this.contextFor(this.users, Math.min(perUser, MULTI_REFERENCE_CONTEXT)));
    for (const kv of space.kvLadder) {
      await this.holdsUsers(kv, ctx);
      this.capacityEnded.add(kv);
    }
    const fitting = space.kvLadder.filter((kv) => this.capacity.get(kv)?.measuredMax !== undefined);
    return fitting.length ? fitting : this.mostUsers(perUser);
  }

  /**
   * "Massimo": the largest context per user of every KV type with N users at once (the capacity search
   * of goal 'single', see the top of this file); returns those that hold N users at all, in the order
   * of goal 'single' (the largest context first), else the most users that fit with 4K each.
   */
  private async largestPerUser(): Promise<TuneKvType[]> {
    const { space } = this.input;
    const ref = Math.min(MULTI_REFERENCE_CONTEXT, this.min);
    if (this.input.spillPossible) await this.reference(this.contextFor(this.users, ref), ref);
    for (const kv of space.kvLadder) await this.searchCapacity(kv);
    const fitting = space.kvLadder.filter((kv) => this.capacity.get(kv)?.measuredMax !== undefined);
    return fitting.length ? this.sweepOrder(fitting) : this.mostUsers(this.min);
  }

  /** Expected ms of N users at once with `perUser` tokens each: prompts read one after the other, answers slowed 15 % per extra user. */
  private levelMs(users: number, perUser: number): number {
    const one = this.requestMs(this.promptOf(perUser), this.out);
    const read = one - this.requestMs(0, this.out);
    return users * read + (one - read) * (1 + 0.15 * (users - 1));
  }

  /** Expected ms of the short conversations of N users (first messages read in full, later ones from the cache). */
  private sessionsMs(users: number, perUser: number): number {
    return this.levelMs(users, perUser) + (this.turns - 1) * this.requestMs(MULTI_FOLLOWUP, this.out) * users;
  }

  /**
   * Expected ms of the work not started yet (goal 'multi'): per KV type that holds the users (or is
   * expected to), its screenings with every user busy, then users 1 … N. "Massimo": first the capacity
   * launches of goal 'single', each type at the context per user it is expected to reach.
   */
  protected override plannedMs(): number {
    const probe = this.loadMs() + this.requestMs(PROBE_DEPTH, PROBE_OUTPUT);
    let ms = this.input.spillPossible && !this.refDone ? probe : 0;
    if (this.largest) {
      let previous: number | undefined;
      for (const kv of this.input.space.kvLadder) {
        const cap = this.capacity.get(kv) as Capacity;
        if (!this.capacityDone.has(kv) && cap.candidates.some((c) => c > (previous ?? 0))) ms += CAPACITY_LAUNCHES * probe;
        const perUser = this.expectedMax(kv, previous);
        if (perUser === undefined) continue;
        previous = perUser;
        ms += this.usersPlanMs(kv, perUser, this.descentLeft.get(kv) ?? this.screensOf(kv));
      }
      return ms;
    }
    let fitting = false;
    for (const kv of this.input.space.kvLadder) {
      const cap = this.capacity.get(kv) as Capacity;
      // A less precise type than one that holds the users holds them too; one being checked is expected to.
      const holds = this.capacityEnded.has(kv) ? cap.measuredMax !== undefined : fitting || cap.candidates.length > 0;
      if (!holds) continue;
      fitting = true;
      // A capacity launch already screened the base settings.
      ms += this.usersPlanMs(kv, this.fixed as number, this.descentLeft.get(kv) ?? this.screensOf(kv) - (cap.launched.size > 0 ? 1 : 0));
    }
    return ms;
  }

  /** Expected ms of what is left of a KV type that holds the users with `perUser` tokens each: `screens` screenings, then users 1 … N. */
  private usersPlanMs(kv: TuneKvType, perUser: number, screens: number): number {
    const load = this.loadMs();
    let ms = this.descended.has(kv) ? 0 : screens * (load + this.levelMs(this.users, perUser) + this.sessionsMs(this.users, perUser));
    // "Solo N utenti": the best's screening is its measurement (nothing more to run).
    if (!this.swept.has(kv) && !this.exact) {
      ms += load;
      for (let n = 1; n <= this.users; n++) ms += this.levelMs(n, perUser);
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
   * Nothing holds N users: the most users (each with `perUser` tokens) that the most compact KV type
   * holds, by binary search; they are measured instead of N. Returns the fitting KV types.
   */
  private async mostUsers(perUser: number): Promise<TuneKvType[]> {
    const ladder = this.input.space.kvLadder;
    const kv = ladder[ladder.length - 1] as TuneKvType;
    let lo = 0;
    let hi = this.users;
    while (hi - lo > 1) {
      const n = Math.floor((lo + hi) / 2);
      const live = await this.launch('capacity', { ...this.base(kv), np: n }, this.contextFor(n, perUser), (e, l) => this.usersWork(e, l));
      if (!live) break;
      if (live.att.outcome === 'ok') lo = n;
      else hi = n;
    }
    if (lo === 0) return [];
    this.fittingUsers = lo;
    this.users = lo;
    const cap = this.capacity.get(kv) as Capacity;
    // "Massimo": the capacity is said per user (launchContext gives the launch of the users that fit).
    cap.measuredMax = this.largest ? perUser : this.contextFor(lo, perUser);
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
    const perUser = this.perUserOf(live);
    const prompt = this.promptOf(perUser);
    const need = level * perUser;
    if (live.hint !== undefined && live.hint < need) {
      att.outcome = 'oom';
      att.error = poolTooSmall(live.hint, need);
      return;
    }
    const predicted = this.levelMs(level, perUser);
    // Every user at once would end past the time limit: not started (the search stops).
    if (!this.fitsInTime(predicted)) {
      att.skipped = [{ depth: prompt, predictedMs: Math.round(predicted) }];
      this.stoppedBy ??= 'budget';
      return;
    }
    const t0 = this.deps.now();
    this.busy(predicted);
    const point = await engine.concurrency(level, prompt, this.out, 1);
    this.settle();
    const levelMs = this.deps.now() - t0;
    att.concurrency = [...(att.concurrency ?? []), point];
    const step = this.sessionsStep(level, perUser);
    const sessions = step ? await engine.sessions(step) : [];
    if (sessions.length) att.sessions = [...(att.sessions ?? []), ...sessions];
    this.usersScreens.set(this.key(live.variant, att.contextSize), { variant: live.variant, ctx: att.contextSize, attempt: live.index, measure: { point, sessions: sessions[0] }, levelMs, live });
  }

  /** "Solo N utenti insieme": a screening (N users at once and the conversations) becomes the combination as it is. */
  private combineScreen(s: UsersScreen): void {
    s.live.users = { concurrency: [s.measure.point], sessions: s.measure.sessions ? [s.measure.sessions] : [] };
    this.addCombination(s.live);
  }

  /**
   * Users 1 … N in this order (one request each), then the conversations (reused from this launch's
   * screening when there is one). A middle level is skipped when the rest of the budget would not
   * leave room for level N.
   */
  private async fullWork(engine: LabEngine, live: Live, screened: UsersScreen): Promise<void> {
    this.deps.onPhase?.('concurrency');
    const level = this.levelOf(live);
    const perUser = this.perUserOf(live);
    const prompt = this.promptOf(perUser);
    const deadline = this.started + Math.max(this.limitMs, this.deps.now() - this.started + MIN_SWEEP_MS);
    const levelMs = screened.levelMs;
    const points: ConcurrencyPoint[] = [];
    for (let n = 1; n <= level; n++) {
      if (n < level && this.deps.now() + (levelMs * n) / level + levelMs > deadline) continue;
      points.push(await engine.concurrency(n, prompt, this.out, 1));
    }
    live.att.concurrency = [...(live.att.concurrency ?? []), ...points];
    let sessions: SessionsPoint[] = screened.measure.sessions && screened.attempt === live.index ? [screened.measure.sessions] : [];
    const step = this.sessionsStep(level, perUser);
    // Part of measuring the users: the live screen stays on that phase.
    if (!sessions.length && step) {
      sessions = await engine.sessions(step);
      live.att.sessions = [...(live.att.sessions ?? []), ...sessions];
    }
    live.users = { concurrency: points, sessions };
  }

  /**
   * The base settings of a fitting KV type screened with all users (launched if not yet). "Massimo": the
   * capacity check only loaded the users; when filling their whole context runs out of memory or
   * spills, the next context per user down is screened instead.
   */
  private async baseUsers(kv: TuneKvType): Promise<UsersScreen | undefined> {
    this.screened(kv);
    const cap = this.capacity.get(kv) as Capacity;
    const base = this.base(kv);
    for (;;) {
      const c = cap.measuredMax as number;
      const ctx = this.launchContext(c);
      const known = this.usersScreens.get(this.key(base, ctx));
      if (known) return known;
      const live = await this.launch('variant', base, ctx, (e, l) => this.usersWork(e, l));
      if (!live) return undefined;
      if (live.att.outcome === 'ok') {
        live.att.screen = 'kept';
        return this.usersScreens.get(this.key(base, ctx));
      }
      const lower = this.largest ? cap.candidates.filter((x) => x < c) : [];
      if (lower.length === 0) {
        delete cap.measuredMax;
        return undefined;
      }
      cap.status.set(c, false);
      cap.measuredMax = lower[lower.length - 1] as number;
    }
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
          // The last value tried (no later dimension has another value for it), and the winner: users 1 … N on this same launch
          // ("solo N utenti": its screening is its measurement, see combineScreen).
          if (won && last && !this.exact) await this.fullWork(engine, l, mine);
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

  /** The context is the request's (N users × their context): there is no largest context to bound ("Massimo": as goal 'single', per user). */
  protected override boundOf(c: Capacity): Partial<Tuning['capacity'][number]> {
    return this.largest && this.fittingUsers === undefined ? super.boundOf(c) : {};
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
      perUserContext: this.perUserOf(live),
      ...(typeof v.reuse === 'number' && v.reuse > 0 ? { cacheReuse: v.reuse } : {}),
    };
  }

  protected override recommend(combos: readonly TuneCombination[]): number | undefined {
    return recommendedForUsers(combos, this.users, undefined, this.largest);
  }

  protected override goalFields(): Partial<Tuning> {
    const turns = this.turns;
    return {
      goal: 'multi',
      multi: {
        users: this.asked,
        ...(this.fixed === undefined ? { perUserContext: 'max' as const } : { perUserContext: this.fixed, promptTokens: this.promptOf(this.fixed) }),
        outputTokens: this.out,
        turns,
        ...(this.exact ? { usersMode: 'exact' as const } : {}),
        ...(this.fittingUsers !== undefined ? { fittingUsers: this.fittingUsers } : {}),
      },
    };
  }
}

