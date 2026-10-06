import { Download, Sparkles } from 'lucide-react';
import { RadioGroup as R } from 'radix-ui';
import { useId, useState } from 'react';
import type { HubFile } from '../../../contract/models';
import type { HubFitResult } from '../../../contract/views';
import { useI18n } from '../../i18n';
import { cn } from '../../lib/cn';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Checkbox } from '../ui/checkbox';
import { FitBadge } from '../ui/fit-badge';
import type { DownloadChoice } from './download-dialog';
import { fileName } from './helpers';
import { TriedFor, useFitDetail } from './model-badges';

type Choice = HubFitResult['choices'][number];

export interface QuantChooserProps {
  repo: string;
  fit: HubFitResult;
  /** mmproj / mtp / draft files the user may add to the download. */
  extras: HubFile[];
  onDownload: (choice: DownloadChoice) => void;
}

/** One radio per quantization, best one preselected, with fit and "already tried" per row. */
export function QuantChooser({ repo, fit, extras, onDownload }: QuantChooserProps) {
  const { t, bytes } = useI18n();
  const detail = useFitDetail();
  const [selected, setSelected] = useState(fit.best ?? (fit.choices[0] as Choice).groupKey);
  const [extra, setExtra] = useState<string[]>([]);
  const extraId = useId();
  const choice = fit.choices.find((c) => c.groupKey === selected) as Choice;
  const extraFiles = extras.filter((f) => extra.includes(f.path));
  const label = (c: Choice) => (c.groupKey === '*weights' ? t('models.detail.wholeRepo') : (c.quant ?? fileName(c.groupKey)));
  const size = choice.sizeBytes + extraFiles.reduce((a, f) => a + f.sizeBytes, 0);

  const download = () =>
    onDownload({
      repo,
      files: choice.groupKey === '*weights' ? ['*'] : [...choice.files.map((f) => f.path), ...extraFiles.map((f) => f.path)],
      label: `${repo.split('/')[1] as string} · ${label(choice)}`,
      sizeBytes: size,
      weakKey: choice.weakKey,
      sha256: [...choice.files].sort((a, b) => a.path.localeCompare(b.path))[0]?.sha256,
    });

  return (
    <div className="flex flex-col gap-4">
      <R.Root value={selected} onValueChange={setSelected} aria-label={t('models.detail.chooseTitle')} className="flex flex-col gap-1.5">
        {fit.choices.map((c) => (
          <R.Item
            key={c.groupKey}
            value={c.groupKey}
            className={cn(
              'group flex min-h-12 flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg border border-border bg-surface px-3 py-2 text-left text-sm transition-colors hover:border-border-strong focus-ring',
              'data-[state=checked]:border-accent data-[state=checked]:bg-accent-soft data-[state=checked]:ring-1 data-[state=checked]:ring-accent',
            )}
          >
            <span
              aria-hidden
              className="grid size-4 shrink-0 place-items-center rounded-full border border-border-strong bg-surface group-data-[state=checked]:border-accent-solid group-data-[state=checked]:bg-accent-solid"
            >
              <span className="size-1.5 rounded-full bg-white opacity-0 group-data-[state=checked]:opacity-100" />
            </span>
            <span className="min-w-24 font-semibold text-fg">{label(c)}</span>
            <span className="text-fg-2 tabular-nums">{bytes(c.sizeBytes)}</span>
            {c.files.length > 1 && <span className="text-xs text-fg-3">{t('models.detail.parts', { n: c.files.length })}</span>}
            <span className="ml-auto flex flex-wrap items-center gap-1.5">
              {c.groupKey === fit.best && (
                <Badge tone="accent" size="sm">
                  <Sparkles aria-hidden />
                  {t('models.detail.best')}
                </Badge>
              )}
              <FitBadge level={c.fit.level} detail={detail(c.fit)} size="sm" />
              <TriedFor weakKey={c.weakKey} />
            </span>
          </R.Item>
        ))}
      </R.Root>
      {extras.length > 0 && choice.groupKey !== '*weights' && (
        <fieldset className="flex flex-col gap-2 rounded-lg border border-border p-3">
          <legend className="px-1 text-xs font-medium text-fg-3">{t('models.detail.extras')}</legend>
          {extras.map((f, i) => (
            <div key={f.path} className="flex items-center gap-2 text-sm">
              <Checkbox
                id={`${extraId}-${i}`}
                checked={extra.includes(f.path)}
                onCheckedChange={(on) => setExtra((x) => (on === true ? [...x, f.path] : x.filter((p) => p !== f.path)))}
              />
              <label htmlFor={`${extraId}-${i}`} className="flex flex-wrap gap-x-2">
                <span className="font-mono text-xs text-fg">{fileName(f.path)}</span>
                <span className="text-fg-3">
                  {t(`models.aux.${f.kind as 'mmproj'}`)} · {bytes(f.sizeBytes)}
                </span>
              </label>
            </div>
          ))}
        </fieldset>
      )}
      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
        <p className="text-sm text-fg-2">{t(`fit.hint.${choice.fit.level}`)}</p>
        <Button variant="primary" size="lg" onClick={download}>
          <Download aria-hidden />
          {t('models.detail.download', { quant: label(choice), size: bytes(size) })}
        </Button>
      </div>
    </div>
  );
}
