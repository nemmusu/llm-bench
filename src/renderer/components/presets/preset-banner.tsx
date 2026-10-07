import { Link } from '@tanstack/react-router';
import { SlidersHorizontal, X } from 'lucide-react';
import { useI18n } from '../../i18n';
import { IconButton } from '../ui/button';
import { provenanceText } from './format';
import type { PresetDraft } from './use-preset-draft';

/** "Preset da «Qwen3 8B» del 07/10: 82 tok/s a 32K, 64K di contesto", with the test it came from; closable. */
export function PresetBanner({ preset }: { preset: PresetDraft }) {
  const f = useI18n();
  const { t } = f;
  const p = preset.provenance;
  if (!p) return null;
  return (
    <section
      aria-label={t('presets.banner.label')}
      className="flex items-center gap-3 rounded-xl border border-accent-line bg-accent-soft/60 px-4 py-3 text-sm shadow-xs"
    >
      <span aria-hidden className="grid size-8 shrink-0 place-items-center rounded-full bg-surface text-accent-text shadow-xs">
        <SlidersHorizontal className="size-4" />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="font-medium text-fg">{provenanceText(p, f)}</span>
        <span className="text-fg-2">{t('presets.banner.hint')}</span>
      </span>
      <Link
        to="/results/$runId"
        params={{ runId: p.runId }}
        className="shrink-0 rounded-xs text-sm font-medium text-accent-text underline-offset-4 hover:underline focus-ring"
      >
        {t('presets.banner.source')}
      </Link>
      <IconButton label={t('presets.banner.dismiss')} icon={<X />} size="sm" onClick={preset.dismiss} />
    </section>
  );
}
