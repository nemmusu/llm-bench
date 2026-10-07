/**
 * "vLLM · Caricamento pesi · 3 di 7 parti (43%) · 0:18 · di solito circa 45 s", a progress bar
 * (indeterminate when the log gives no fraction) and the stages done so far with their durations.
 */
import { Progress as P } from 'radix-ui';
import type { EngineKind } from '../../../contract/engines';
import type { LoadProgress, LoadStage } from '../../../contract/events';
import { useI18n, type MessageKey } from '../../i18n';
import { cn } from '../../lib/cn';
import { HelpTip } from '../ui/help-tip';
import { clock, engineName, shortDuration, stageProgressText } from './load-progress';

/** Stages worth a word of explanation. */
const HELP: Partial<Record<LoadStage, MessageKey>> = {
  compile: 'load.help.compile',
  'memory-profile': 'load.help.memory-profile',
  'kv-cache': 'load.help.kv-cache',
  'cuda-graphs': 'load.help.cuda-graphs',
  warmup: 'load.help.warmup',
};

export interface LoadLineProps {
  progress: LoadProgress;
  engineKind: EngineKind;
  /** Stages already finished, with how long they took. */
  stages?: readonly { stage: LoadStage; ms: number }[];
  className?: string;
}

export function LoadLine({ progress: p, engineKind, stages = [], className }: LoadLineProps) {
  const f = useI18n();
  const { t } = f;
  const name = engineName(engineKind);
  const ready = p.stage === 'ready';
  const help = HELP[p.stage];
  const head = ready ? t('load.readyIn', { time: clock(p.elapsedMs) }) : stageProgressText(p, engineKind, f);
  const label = t('load.label');
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <p className="flex flex-wrap items-center gap-x-1.5 text-sm text-fg-2 tabular-nums">
        {name && <span className="font-medium text-fg">{name}</span>}
        {name && <span aria-hidden>·</span>}
        <span className={cn(ready ? 'text-success-text' : 'text-fg')}>{head}</span>
        {help && <HelpTip term={t(`load.stages.${p.stage}`)}>{t(help)}</HelpTip>}
        {!ready && (
          <>
            <span aria-hidden>·</span>
            <span>{clock(p.elapsedMs)}</span>
            {p.expectedMs !== undefined && <span className="text-fg-3">{t('load.usually', { time: shortDuration(p.expectedMs, f) })}</span>}
          </>
        )}
      </p>
      {p.detail && !ready && <p className="truncate font-mono text-xs text-fg-3">{p.detail}</p>}
      {!ready &&
        (p.fraction === undefined ? (
          <P.Root value={null} aria-label={label} aria-valuetext={t('load.indeterminate')} className="relative h-1 w-full overflow-hidden rounded-full bg-surface-3">
            <P.Indicator className="h-full w-full animate-shimmer bg-[linear-gradient(90deg,transparent,var(--accent),transparent)] bg-[length:200%_100%]" />
          </P.Root>
        ) : (
          <P.Root value={Math.round(p.fraction * 100)} max={100} aria-label={label} className="relative h-1 w-full overflow-hidden rounded-full bg-surface-3">
            <P.Indicator className="h-full rounded-full bg-accent transition-[width] duration-300" style={{ width: `${p.fraction * 100}%` }} />
          </P.Root>
        ))}
      {stages.length > 0 && (
        <ul aria-label={t('load.stagesDone')} className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-fg-3 tabular-nums">
          {stages.map((s, i) => {
            const why = HELP[s.stage];
            return (
              <li key={i} className="inline-flex items-center gap-1">
                <span className="text-fg-2">{t(`load.short.${s.stage}`)}</span>
                {shortDuration(s.ms, f)}
                {why && <HelpTip term={t(`load.short.${s.stage}`)} className="size-4">{t(why)}</HelpTip>}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
