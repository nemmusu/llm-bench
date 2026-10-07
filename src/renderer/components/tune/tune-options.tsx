import { useState, type ReactNode } from 'react';
import type { RunPlan, StartRunRequest } from '../../../contract/api';
import { TUNE_MAX_USERS, TUNE_MULTI_DEFAULTS, TUNE_PER_USER_CONTEXTS, type TuneBudget, type TuneGoal } from '../../../contract/results';
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
 * "Veloce"), the fidelity check (experts), the goal with its users and context per user.
 */
export function tuneRequestOf(v: TuneRequest, o: { expert: boolean; previous: RunPlan['previousTune'] }): TuneRequest {
  const budget: TuneBudget = v.budget === 'recheck' && !recheckOffered(o.previous) ? 'fast' : v.budget;
  return {
    budget,
    // The fidelity check compares one-user caches; a recheck measures nothing new to compare.
    fidelity: o.expert && v.fidelity && v.goal !== 'multi' && budget !== 'recheck',
    ...(v.goal === 'multi'
      ? { goal: 'multi' as const, users: v.users ?? TUNE_MULTI_DEFAULTS.users, perUserContext: v.perUserContext ?? TUNE_MULTI_DEFAULTS.perUserContext }
      : {}),
  };
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
}

/**
 * Options of "Trova le impostazioni migliori" on the Benchmark page: what the search is for (one user
 * with the largest context, or several users with their own context each), how long to search
 * ("Ricontrollo rapido" when the engine changed since the last search) and (experts only) the fidelity
 * check, which is an indication and not a quality test.
 */
export function TuneOptions({ value, onChange, expert, previous, times, recheckTime, children }: TuneOptionsProps) {
  const f = useI18n();
  const { t } = f;
  // "~20 min": the search's own forecast for this model, once the plan says (and a line says so).
  const timeOf = (seconds: number | undefined, fallback: Parameters<typeof t>[0]) => (seconds === undefined ? t(fallback) : t('tune.options.modelTime', { time: roughDuration(seconds) }));
  const goal: TuneGoal = value.goal ?? 'single';
  const users = value.users ?? TUNE_MULTI_DEFAULTS.users;
  const perUser = value.perUserContext ?? TUNE_MULTI_DEFAULTS.perUserContext;
  const [usersText, setUsersText] = useState(String(users));
  const usersInvalid = parseUsers(usersText) === undefined;
  const offered = recheckOffered(previous);
  const budget: TuneBudget = value.budget === 'recheck' && !offered ? 'fast' : value.budget;
  const budgetDesc =
    budget === 'recheck' && offered
      ? t('tune.options.recheckDesc', { build: buildLabel(previous.build, f), current: buildLabel(previous.currentBuild, f) })
      : t(budget === 'thorough' ? 'tune.options.thoroughDesc' : 'tune.options.fastDesc');
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border bg-surface-2/60 p-3">
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
        <div className="grid gap-3 sm:grid-cols-[8rem_1fr]">
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
              label={t('tune.options.perUserContext')}
              value={String(perUser)}
              onValueChange={(v) => onChange({ ...value, goal: 'multi', users, perUserContext: Number(v) })}
              options={TUNE_PER_USER_CONTEXTS.map((c) => ({ value: String(c), label: depthLabel(c, f) }))}
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
    </div>
  );
}
