/**
 * "Usa questo preset" and "Avvia il server così" for a test (or one combination of a "Trova le
 * impostazioni migliori" test): one click from any list or page to the same engine, model and
 * settings. Used by Risultati → Configurazioni, the result page header and the tune result page.
 */
import { useNavigate } from '@tanstack/react-router';
import { Download, Search, Server, SlidersHorizontal } from 'lucide-react';
import type { RunResult } from '../../../contract/results';
import { useI18n } from '../../i18n';
import { cn } from '../../lib/cn';
import { modelLabelOf } from '../bench/format';
import { Button, IconButton } from '../ui/button';
import { HelpTip } from '../ui/help-tip';
import { usePreset } from './use-preset';

export interface PresetActionsProps {
  run: RunResult;
  /** Index into run.tuning.combinations: that combination's settings (ignored for a run without them). */
  combo?: number;
  /** The depth the Benchmark page's banner quotes ("82 tok/s a 32K"); default: the test's own headline. */
  at?: number;
  /** "compact" (table rows): the server action as an icon, the notes shortened. */
  layout?: 'full' | 'compact';
  className?: string;
}

export function PresetActions({ run, combo, at, layout = 'full', className }: PresetActionsProps) {
  const { t, bytes } = useI18n();
  const navigate = useNavigate();
  const p = usePreset(run, { combo, at });
  const preset = p.preset;
  const compact = layout === 'compact';
  const model = modelLabelOf(run.model);
  const size = preset?.draft.hub?.sizeBytes;

  if (preset?.model === 'missing') {
    return (
      <div role="group" aria-label={t('presets.group', { model })} className={cn('flex flex-wrap items-center gap-2', className)}>
        <Button size="sm" onClick={() => void navigate({ to: '/models', search: { tab: 'download' } })}>
          <Search aria-hidden />
          {t('presets.findModel')}
        </Button>
        {compact ? (
          <HelpTip term={t('presets.findModel')}>{t('presets.missingNote')}</HelpTip>
        ) : (
          <span className="text-sm text-warning-text">{t('presets.missingNote')}</span>
        )}
      </div>
    );
  }

  const serveLabel = t('presets.serve');
  // In a table row: a short note under the buttons; on a page: the whole sentence next to them.
  const note = compact
    ? size === undefined
      ? t('presets.toDownloadNoSize')
      : t('presets.toDownload', { size: bytes(size) })
    : size === undefined
      ? t('presets.downloadNoteNoSize')
      : t('presets.downloadNote', { size: bytes(size) });
  return (
    <div role="group" aria-label={t('presets.group', { model })} className={cn('flex gap-x-2 gap-y-1', compact ? 'flex-col items-start' : 'flex-wrap items-center', className)}>
      <span className="flex items-center gap-2">
        <Button variant="primary" size="sm" disabled={!preset} onClick={p.apply}>
          {!compact && <SlidersHorizontal aria-hidden />}
          {t('presets.use')}
        </Button>
        {run.engine.kind !== 'external' &&
          (compact ? (
            <IconButton label={serveLabel} icon={<Server />} variant="outline" size="sm" disabled={!preset} onClick={p.serve} />
          ) : (
            <Button variant="outline" size="sm" disabled={!preset} onClick={p.serve}>
              <Server aria-hidden />
              {serveLabel}
            </Button>
          ))}
      </span>
      {preset?.model === 'download' && (
        <span className="inline-flex items-center gap-1.5 text-xs text-accent-text">
          <Download aria-hidden className="size-3.5" />
          {note}
        </span>
      )}
    </div>
  );
}
