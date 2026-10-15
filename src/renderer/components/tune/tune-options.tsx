import { useState, type ReactNode } from 'react';
import type { RunPlan, StartRunRequest } from '../../../contract/api';
import { defaultYarnTarget } from '../../../contract/recipes';
import { TUNE_MAX_USERS, TUNE_MIN_PER_USER_CONTEXT, TUNE_MULTI_DEFAULTS, TUNE_PER_USER_CONTEXTS, type TuneBudget, type TuneGoal, type TunePerUserContext, type TuneUsersMode } from '../../../contract/results';
import { YarnChoice } from '../recipes/yarn-choice';
import { useI18n } from '../../i18n';
import { Field, Input } from '../ui/input';
import { HelpTip } from '../ui/help-tip';
import { SegmentedControl } from '../ui/segmented-control';
import { Switch } from '../ui/switch';
import { buildLabel, depthLabel, roughDuration } from './tune-format';

export type TuneRequest = NonNullable<StartRunRequest['tune']>;

export const DEFAULT_TUNE: TuneRequest = { budget: 'fast', fidelity: false };

/** "Ricontrollo rapido" is offered when the latest tune of the same question ran with another engine build. */
export function recheckOffered(previous: RunPlan['previousTune']): previous is NonNullable<RunPlan['previousTune']> {
  return previous !== undefined && !previous.sameBuild;
}

/**
 * The tune part of a request: the budget ("Ricontrollo rapido" only when offered, else back to
 * "Veloce"), the fidelity check and the YaRN extension (experts, one user), the goal with its users and
 * context per user.
 */
export function tuneRequestOf(v: TuneRequest, o: { expert: boolean; previous: RunPlan['previousTune'] }): TuneRequest {
  const budget: TuneBudget = v.budget === 'recheck' && !recheckOffered(o.previous) ? 'fast' : v.budget;
  return {
    budget,
    // The fidelity check compares one-user caches; a recheck measures nothing new to compare.
    fidelity: o.expert && v.fidelity && v.goal !== 'multi' && budget !== 'recheck',
    ...(o.expert && v.yarnTarget !== undefined && v.goal !== 'multi' && budget !== 'recheck' ? { yarnTarget: v.yarnTarget } : {}),
    ...(v.goal === 'multi'
      ? {
          goal: 'multi' as const,
          users: v.users ?? TUNE_MULTI_DEFAULTS.users,
          perUserContext: v.perUserContext ?? TUNE_MULTI_DEFAULTS.perUserContext,
          // "Solo N utenti insieme"; users 1 … N is the default and is not sent.
          ...(v.usersMode === 'exact' ? { usersMode: 'exact' as const } : {}),
        }
      : {}),
  };
}

/** The largest context per user the request accepts when the model does not say its own. */
export const PER_USER_CONTEXT_LIMIT = 1_048_576;

/**
 * A context per user typed in the "Altro…" box: tokens ("98304", "98.304") or thousands of tokens
 * ("96K", 1K = 1,024), a whole number from 1K up to `max` (the model's context); else undefined.
 */
export function parsePerUserContext(text: string, max = PER_USER_CONTEXT_LIMIT): number | undefined {
  const m = /^\s*(\d+(?:[.,]\d{3})*)\s*(k?)\s*$/i.exec(text);
  if (!m) return undefined;
  const digits = Number((m[1] as string).replace(/[.,]/g, ''));
  const n = m[2] ? digits * 1024 : digits;
  return n >= TUNE_MIN_PER_USER_CONTEXT && n <= max ? n : undefined;
}

/** The segment of a context per user: 'max', one of the sizes offered, or 'other' (a value typed in "Altro…"). */
export function perUserSegment(v: TunePerUserContext): string {
  if (v === 'max') return 'max';
  return (TUNE_PER_USER_CONTEXTS as readonly number[]).includes(v) ? String(v) : 'other';
}

/** Users typed in the box: a whole number from 2 to TUNE_MAX_USERS, else undefined. */
export function parseUsers(text: string): number | undefined {
  const n = /^\s*\d+\s*$/.test(text) ? Number(text) : NaN;
  return Number.isInteger(n) && n >= 2 && n <= TUNE_MAX_USERS ? n : undefined;
}

export interface TuneOptionsProps {
  value: TuneRequest;
  onChange: (v: TuneRequest) => void;
  expert: boolean;
  /** The latest tune of the same question (from the plan): "Ricontrollo rapido" when it ran with another build. */
  previous?: RunPlan['previousTune'];
  /** How long each budget takes for this model (the plan's forecast); absent until the plan says. */
  times?: RunPlan['tuneSeconds'] | undefined;
  /** "Ricontrollo rapido" chosen: how long it takes (the plan's estimate). */
  recheckTime?: number | undefined;
  /** More choices shown first, in the same box. */
  children?: ReactNode;
  /** The model's trained context: "Cerca anche oltre il limite del modello (YaRN)" (experts). */
  trainedContext?: number | undefined;
}

/**
 * Options of "Trova le impostazioni migliori" on the Benchmark page: what the search is for (one user
 * with the largest context, or several users with their own context each), how long to search
 * ("Ricontrollo rapido" when the engine changed since the last search) and (experts only) the fidelity
 * check, which is an indication and not a quality test.
 */
export function TuneOptions({ value, onChange, expert, previous, times, recheckTime, children, trainedContext }: TuneOptionsProps) {
  const f = useI18n();
  const { t } = f;
  // "~20 min": the search's own forecast for this model, once the plan says (and a line says so).
  const timeOf = (seconds: number | undefined, fallback: Parameters<typeof t>[0]) => (seconds === undefined ? t(fallback) : t('tune.options.modelTime', { time: roughDuration(seconds) }));
  const goal: TuneGoal = value.goal ?? 'single';
  const users = value.users ?? TUNE_MULTI_DEFAULTS.users;
  const perUser: TunePerUserContext = value.perUserContext ?? TUNE_MULTI_DEFAULTS.perUserContext;
  const [usersText, setUsersText] = useState(String(users));
  // "Altro…": chosen (a typed value shows it), and the text as typed (the request keeps the last valid value).
  const [other, setOther] = useState(perUserSegment(perUser) === 'other');
  const [otherText, setOtherText] = useState(typeof perUser === 'number' ? String(perUser) : String(TUNE_MULTI_DEFAULTS.perUserContext));
  const contextMax = trainedContext ?? PER_USER_CONTEXT_LIMIT;
  const otherInvalid = parsePerUserContext(otherText, contextMax) === undefined;
  const segment = other ? 'other' : perUserSegment(perUser);
  const setPerUser = (c: TunePerUserContext) => onChange({ ...value, goal: 'multi', users, perUserContext: c });
  // The YaRN context as typed: the request keeps the last whole number.
  const [yarnText, setYarnText] = useState(value.yarnTarget === undefined ? '' : String(value.yarnTarget));
  const usersInvalid = parseUsers(usersText) === undefined;
  const offered = recheckOffered(previous);
  const budget: TuneBudget = value.budget === 'recheck' && !offered ? 'fast' : value.budget;
  const budgetDesc =
    budget === 'recheck' && offered
      ? t('tune.options.recheckDesc', { build: buildLabel(previous.build, f), current: buildLabel(previous.currentBuild, f) })
      : t(budget === 'thorough' ? 'tune.options.thoroughDesc' : 'tune.options.fastDesc');
  return (
    // A container: in a narrow card (the profile column of Benchmark) the users and their context go one under the other.
    <div className="@container flex flex-col gap-3 rounded-lg border border-border bg-surface-2/60 p-3">
      {children}
      <div className="flex flex-col gap-1.5">
        <span className="inline-flex items-center gap-1 text-xs font-medium text-fg-2">
          {t('tune.options.goal')}
          <HelpTip term={t('tune.options.goal')}>{t('tune.options.goalHelp')}</HelpTip>
        </span>
        <SegmentedControl<TuneGoal>
          layout="list"
          label={t('tune.options.goal')}
          value={goal}
          onValueChange={(g) => onChange(g === 'multi' ? { ...value, goal: 'multi', users, perUserContext: perUser } : { budget: value.budget, fidelity: value.fidelity })}
          options={[
            { value: 'single', label: t('tune.options.single') },
            { value: 'multi', label: t('tune.options.multi') },
          ]}
        />
        <p className="text-xs text-fg-3">{t(goal === 'multi' ? 'tune.options.multiDesc' : 'tune.options.singleDesc')}</p>
      </div>
      {goal === 'multi' && (
        <div className="grid gap-3 @xs:grid-cols-[8rem_1fr]">
          <Field
            label={t('tune.options.users')}
            aside={<HelpTip term={t('tune.options.users')}>{t('tune.options.usersHelp')}</HelpTip>}
            hint={<span className={usersInvalid ? 'text-danger-text' : undefined}>{t('tune.options.usersHint', { max: TUNE_MAX_USERS })}</span>}
          >
            {({ id, describedBy }) => (
              <Input
                id={id}
                inputMode="numeric"
                aria-describedby={describedBy}
                aria-invalid={usersInvalid || undefined}
                value={usersText}
                onChange={(e) => {
                  setUsersText(e.target.value);
                  const n = parseUsers(e.target.value);
                  if (n !== undefined) onChange({ ...value, goal: 'multi', users: n, perUserContext: perUser });
                }}
                className="tabular-nums"
                autoComplete="off"
              />
            )}
          </Field>
          <div className="flex flex-col gap-1.5">
            <span className="inline-flex items-center gap-1 text-sm font-medium text-fg">
              {t('tune.options.perUserContext')}
              <HelpTip term={t('tune.options.perUserContext')}>{t('tune.options.perUserContextHelp')}</HelpTip>
            </span>
            <SegmentedControl
              size="sm"
              fullWidth
              // Never past the card's edge: the sizes go on a second row when the card is narrow.
              className="flex-wrap"
              label={t('tune.options.perUserContext')}
              value={segment}
              onValueChange={(v) => {
                setOther(v === 'other');
                if (v === 'other') {
                  // The box starts from the context chosen so far: the request stays what the box says.
                  const start = typeof perUser === 'number' ? perUser : TUNE_MULTI_DEFAULTS.perUserContext;
                  setOtherText(String(start));
                  setPerUser(start);
                } else setPerUser(v === 'max' ? 'max' : Number(v));
              }}
              options={[
                { value: 'max', label: t('tune.options.perUserMax') },
                ...TUNE_PER_USER_CONTEXTS.map((c) => ({ value: String(c), label: depthLabel(c, f) })),
                { value: 'other', label: t('tune.options.perUserOther') },
              ]}
            />
            {segment === 'max' && (
              <p className="inline-flex items-start gap-1 text-xs text-fg-3">
                {t('tune.options.perUserMaxDesc', { n: users })}
                <HelpTip term={t('tune.options.perUserMax')}>{t('tune.options.perUserMaxHelp')}</HelpTip>
              </p>
            )}
          </div>
          {segment === 'other' && (
            <Field
              className="@xs:col-span-2"
              label={t('tune.options.perUserOtherLabel')}
              hint={
                <span className={otherInvalid ? 'text-danger-text' : undefined}>
                  {trainedContext === undefined ? t('tune.options.perUserOtherHintOpen') : t('tune.options.perUserOtherHint', { max: depthLabel(trainedContext, f), tokens: f.integer(trainedContext) })}
                </span>
              }
            >
              {({ id, describedBy }) => (
                <Input
                  id={id}
                  aria-describedby={describedBy}
                  aria-invalid={otherInvalid || undefined}
                  value={otherText}
                  onChange={(e) => {
                    setOtherText(e.target.value);
                    const n = parsePerUserContext(e.target.value, contextMax);
                    if (n !== undefined) setPerUser(n);
                  }}
                  className="tabular-nums"
                  autoComplete="off"
                />
              )}
            </Field>
          )}
          <div className="flex flex-col gap-1.5 @xs:col-span-2">
            <span className="inline-flex items-center gap-1 text-sm font-medium text-fg">
              {t('tune.options.usersMode')}
              <HelpTip term={t('tune.options.usersMode')}>{t('tune.options.usersModeHelp')}</HelpTip>
            </span>
            <SegmentedControl<TuneUsersMode>
              layout="list"
              label={t('tune.options.usersMode')}
              value={value.usersMode ?? 'ramp'}
              onValueChange={(m) => onChange({ ...value, goal: 'multi', users, perUserContext: perUser, usersMode: m })}
              options={[
                { value: 'ramp', label: t('tune.options.usersRamp', { n: users }) },
                { value: 'exact', label: t('tune.options.usersExact', { n: users }) },
              ]}
            />
          </div>
        </div>
      )}
      <div className="flex flex-col gap-1.5">
        <span className="inline-flex items-center gap-1 text-xs font-medium text-fg-2">
          {t('tune.options.budget')}
          <HelpTip term={t('tune.options.budget')}>{t('tune.options.budgetHelp')}</HelpTip>
        </span>
        <SegmentedControl<TuneBudget>
          layout="list"
          label={t('tune.options.budget')}
          value={budget}
          onValueChange={(b) => onChange({ ...value, budget: b })}
          options={[
            ...(offered ? [{ value: 'recheck' as const, label: t('tune.options.recheck'), sublabel: timeOf(recheckTime, 'tune.options.recheckTime') }] : []),
            { value: 'fast', label: t('tune.options.fast'), sublabel: timeOf(times?.fast, 'tune.options.fastTime') },
            { value: 'thorough', label: t('tune.options.thorough'), sublabel: timeOf(times?.thorough, 'tune.options.thoroughTime') },
          ]}
        />
        <p className="text-xs text-fg-3">
          {budgetDesc}
          {times && <> {t('tune.options.modelTimeHint')}</>}
        </p>
      </div>
      {expert && budget !== 'recheck' && goal !== 'multi' && (
        <div className="flex items-start gap-2.5">
          <Switch id="tune-fidelity" checked={value.fidelity} onCheckedChange={(fidelity) => onChange({ ...value, fidelity })} aria-describedby="tune-fidelity-hint" className="mt-0.5" />
          <div className="flex flex-col">
            <label htmlFor="tune-fidelity" className="cursor-pointer text-sm font-medium text-fg">
              {t('tune.options.fidelity')}
            </label>
            <span id="tune-fidelity-hint" className="text-xs text-fg-3">
              {t('tune.options.fidelityHint')}
            </span>
          </div>
        </div>
      )}
      {expert && budget !== 'recheck' && goal !== 'multi' && (
        <div className="flex flex-col gap-2">
          <div className="flex items-start gap-2.5">
            <Switch
              id="tune-yarn"
              checked={value.yarnTarget !== undefined}
              disabled={trainedContext === undefined}
              onCheckedChange={(on) => {
                const { yarnTarget: _off, ...rest } = value;
                const first = defaultYarnTarget(trainedContext as number);
                setYarnText(on ? String(first) : '');
                onChange(on ? { ...value, yarnTarget: first } : rest);
              }}
              aria-describedby="tune-yarn-hint"
              className="mt-0.5"
            />
            <div className="flex flex-col">
              <label htmlFor="tune-yarn" className="cursor-pointer text-sm font-medium text-fg">
                {t('context.yarn.tune')}
              </label>
              <span id="tune-yarn-hint" className="text-xs text-fg-3">
                {trainedContext === undefined ? t('context.yarn.tuneUnknown') : t('context.yarn.tuneHint', { trained: f.integer(trainedContext) })}
              </span>
            </div>
          </div>
          {value.yarnTarget !== undefined && (
            <YarnChoice
              value={yarnText}
              onChange={(v) => {
                setYarnText(v);
                const n = Number(v);
                if (Number.isInteger(n) && n > 0) onChange({ ...value, yarnTarget: n });
              }}
              trained={trainedContext}
            />
          )}
        </div>
      )}
    </div>
  );
}
