/**
 * A run whose model did not fit in VRAM: Windows put part of it in shared system memory and every
 * number is far below the card's real one, with no error anywhere. Said first and plainly, with the
 * numbers, and with the ways out (the result page, the live screen, lists and badges).
 */
import { HardDrive, TriangleAlert } from 'lucide-react';
import type { LaunchParams } from '../../../contract/engines';
import type { LiveSpill } from '../../../contract/events';
import type { Spill } from '../../../contract/results';
import { useI18n, type Formatters } from '../../i18n';
import { cn } from '../../lib/cn';
import { depthLabel } from '../tune/tune-format';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Tooltip } from '../ui/tooltip';
import { MIB_PER_GB } from './format';

type F = Pick<Formatters, 't' | 'number' | 'integer'>;

/** "4,6 GB" from MiB. */
const gb = (mib: number, f: F) => `${f.number(mib / MIB_PER_GB, 1)} GB`;

/**
 * What happened, in one or two sentences with the numbers: the shared memory Windows used and how much
 * slower it was than usual (when an earlier run says what usual is), or the collapse alone. A spill
 * found later in an older run (Spill.inferred) says how much slower than the others it was, as a probability.
 */
export function spillText(spill: Pick<Spill, 'by' | 'sharedPeakMiB' | 'decodeTps' | 'normalDecodeTps' | 'inferred'>, f: F): string {
  const { decodeTps: tps, normalDecodeTps: normal, sharedPeakMiB: shared } = spill;
  const times = tps && normal ? Math.round(normal / tps) : 0;
  // "Circa N volte più lento" only when it is (a collapse always is: below 0.4×).
  const speeds = times >= 2 ? { tps: f.number(tps as number, 1), normal: f.number(normal as number, 1), times: f.integer(times) } : undefined;
  if (spill.by.includes('shared-memory') && shared !== undefined) {
    return speeds ? f.t('spill.shared', { size: gb(shared, f), ...speeds }) : f.t('spill.sharedNoNormal', { size: gb(shared, f) });
  }
  // A collapse is only ever seen against the usual speed: both are there.
  return f.t(spill.inferred ? 'spill.inferred' : 'spill.collapse', speeds as NonNullable<typeof speeds>);
}

export interface SpillWarningProps {
  spill: Spill;
  /** "Trova le impostazioni migliori": the Benchmark page with the search and this model. */
  onFindSettings: () => void;
  /** The same test again with these launch settings changed (q4_0 cache, or less context). */
  onRetry: (patch: Partial<LaunchParams>) => void;
  className?: string;
}

/** The result page's first word on a run that spilled: what happened, that the numbers are not the card's, the ways out. */
export function SpillWarning({ spill, onFindSettings, onRetry, className }: SpillWarningProps) {
  const f = useI18n();
  const { t } = f;
  const fixes = spill.fixes;
  return (
    <section role="alert" aria-labelledby="spill-title" className={cn('rounded-xl border border-warning/40 bg-warning-soft p-5', className)}>
      <div className="flex items-start gap-3">
        <TriangleAlert aria-hidden className="mt-0.5 size-5 shrink-0 text-warning-text" />
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <h2 id="spill-title" className="text-md font-semibold text-fg">
            {t(spill.inferred ? 'spill.inferredTitle' : 'spill.title')}
          </h2>
          <p className="text-sm text-fg-2">
            {spillText(spill, f)} <span className="font-medium text-fg">{t('spill.notReal')}</span>
          </p>
          <div className="flex flex-wrap gap-2 pt-1">
            <Button size="sm" variant="primary" onClick={onFindSettings}>
              {t('spill.tune')}
            </Button>
            {fixes?.kvCacheType && (
              <Button size="sm" onClick={() => onRetry({ kvCacheType: 'q4_0', flashAttention: 'on' })}>
                {t('spill.q4')}
              </Button>
            )}
            {fixes?.maxContext !== undefined && (
              <Button size="sm" onClick={() => onRetry({ contextSize: fixes.maxContext })}>
                {t('spill.context', { ctx: depthLabel(fixes.maxContext, f) })}
              </Button>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

/** The live screen, the moment a spill is seen: the numbers will be much lower; cancelling is one click. */
export function LiveSpillBanner({ spill, onCancel, cancelling }: { spill: LiveSpill; onCancel: () => void; cancelling: boolean }) {
  const f = useI18n();
  const { t } = f;
  const shared = spill.by.includes('shared-memory') && spill.sharedPeakMiB !== undefined;
  const body = shared
    ? t('spill.live.shared', { size: gb(spill.sharedPeakMiB as number, f) })
    : t('spill.live.collapse', { tps: f.number(spill.decodeTps as number, 1), normal: f.number(spill.normalDecodeTps as number, 1) });
  return (
    <section role="alert" aria-labelledby="live-spill-title" className="flex flex-col gap-3 rounded-xl border border-warning/40 bg-warning-soft px-5 py-4 sm:flex-row sm:items-center">
      <HardDrive aria-hidden className="size-5 shrink-0 text-warning-text" />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <h2 id="live-spill-title" className="text-md font-semibold text-fg">
          {t('spill.live.title')}
        </h2>
        <p className="text-sm text-fg-2">{body}</p>
      </div>
      <Button variant="danger-outline" size="sm" onClick={onCancel} disabled={cancelling} className="self-start sm:self-center">
        {t('spill.live.cancel')}
      </Button>
    </section>
  );
}

/** "RAM condivisa": a run or a configuration whose numbers are not the card's (lists, Configurazioni). */
export function SpillBadge({ className }: { className?: string }) {
  const { t } = useI18n();
  return (
    <Tooltip content={t('spill.badgeHelp')}>
      <Badge tone="warning" size="sm" className={className}>
        <HardDrive aria-hidden />
        {t('spill.badge')}
      </Badge>
    </Tooltip>
  );
}
