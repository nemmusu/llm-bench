import { MonitorCog } from 'lucide-react';
import { BUSY_NOTE_SHARE, busyVram, VRAM_RESERVE_MIB, type FitEstimate } from '../../../contract/models';
import { useI18n } from '../../i18n';
import { useVramNow } from '../../lib/queries-library';
import { HelpTip } from '../ui/help-tip';

const MIB = 1024 * 1024;

/** The "?" that explains why the verdict looks at the card's total and what "free right now" means. */
export function FitTotalHelp({ totalMiB }: { totalMiB: number | undefined }) {
  const { t, bytes } = useI18n();
  if (totalMiB === undefined) return null;
  return (
    <HelpTip term={t('fit.totalTerm')}>
      {t('fit.totalHelp', { total: bytes(totalMiB * MIB), reserve: bytes(VRAM_RESERVE_MIB * MIB) })}
    </HelpTip>
  );
}

/**
 * "Ora altri programmi usano 6,2 GB della scheda": a calm note before a test or a server, when what other
 * programs hold right now matters (contract busyVram). The verdict itself stays on the card's total.
 */
export function BusyVramNote({ fit, kind }: { fit: Pick<FitEstimate, 'totalMiB' | 'busyMiB' | 'freeNowMiB' | 'level' | 'levelNow'> | undefined; kind: 'run' | 'server' }) {
  const { t, bytes } = useI18n();
  const busy = fit && busyVram(fit);
  if (!busy) return null;
  return (
    <p role="note" className="flex items-start gap-2.5 rounded-lg border border-info/25 bg-info-soft px-3.5 py-2.5 text-sm text-fg-2">
      <MonitorCog aria-hidden className="mt-0.5 size-4 shrink-0 text-info-text" />
      <span>
        <span className="font-medium text-fg">{t('fit.busy.title', { used: bytes(busy.busyMiB * MIB) })}</span>{' '}
        {t(kind === 'run' ? 'fit.busy.run' : 'fit.busy.server', { free: bytes(busy.freeMiB * MIB) })}
      </span>
    </p>
  );
}

/** One small banner above the catalog when other programs hold a good part of the card right now. */
export function CatalogBusyNote() {
  const { t, bytes } = useI18n();
  const v = useVramNow().data;
  if (!v || v.busyMiB - v.reserveMiB < BUSY_NOTE_SHARE * v.totalMiB) return null;
  return (
    <p role="note" className="flex items-center gap-2.5 rounded-lg border border-info/25 bg-info-soft px-3.5 py-2 text-xs text-fg-2">
      <MonitorCog aria-hidden className="size-4 shrink-0 text-info-text" />
      <span>
        <span className="font-medium text-fg">{t('fit.busy.title', { used: bytes(v.busyMiB * MIB) })}</span> {t('fit.busy.catalog')}
      </span>
    </p>
  );
}
