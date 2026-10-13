import { Download, FolderTree, Sparkles } from 'lucide-react';
import { RadioGroup as R } from 'radix-ui';
import { useId, useState } from 'react';
import { NINFER_CONTAINER_VERSION } from '../../../contract/formats';
import type { HubFile } from '../../../contract/models';
import type { HubFitResult } from '../../../contract/views';
import { useI18n } from '../../i18n';
import { cn } from '../../lib/cn';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Checkbox } from '../ui/checkbox';
import { FitBadge } from '../ui/fit-badge';
import type { DownloadChoice } from './download-dialog';
import { ForkBadge, type ModelFormat } from './formats';
import { fileName } from './helpers';
import { TriedFor, useFitDetail } from './model-badges';

type Choice = HubFitResult['choices'][number];

export interface QuantChooserProps {
  repo: string;
  fit: HubFitResult;
  /** What the choices are: GGUF quants, safetensors folders, NInfer artifacts. */
  format: ModelFormat;
  /** GGUF: mmproj / mtp / draft files the user may add to the download. */
  extras?: HubFile[];
  /** NInfer: the card cannot run it (not an RTX 5090): each choice says so. */
  unsupported?: boolean;
  onDownload: (choice: DownloadChoice) => void;
}

/** The folder of a choice in the repo ("cartella GGUF", "cartella INT4/W4A16"), when it is not the root. */
function folderOf(c: Choice): string | undefined {
  if (c.dir !== undefined) return c.dir || undefined;
  const first = (c.files[0] as HubFile).path;
  return first.includes('/') ? first.slice(0, first.lastIndexOf('/')) : undefined;
}

/**
 * One radio per choice of a format, the best one preselected, with fit and "already tried" per row:
 * GGUF quants (with the optional extras), safetensors folders and NInfer artifacts, each downloaded as
 * exactly its files.
 */
export function QuantChooser({ repo, fit, format, extras = [], unsupported, onDownload }: QuantChooserProps) {
  const { t, bytes } = useI18n();
  const detail = useFitDetail();
  const [picked, setPicked] = useState<string>();
  const [extra, setExtra] = useState<string[]>([]);
  const extraId = useId();
  // A pick that is not among the choices any more (the list was refreshed) falls back to the best one.
  const selected = picked !== undefined && fit.choices.some((c) => c.groupKey === picked) ? picked : (fit.best ?? (fit.choices[0] as Choice).groupKey);
  const choice = fit.choices.find((c) => c.groupKey === selected) as Choice;
  const extraFiles = format === 'gguf' ? extras.filter((f) => extra.includes(f.path)) : [];
  const name = repo.split('/')[1] as string;
  const label = (c: Choice) => {
    if (format === 'ninfer') return fileName(c.groupKey);
    if (format === 'safetensors') return c.quant ?? t('models.detail.wholeRepo');
    return c.quant ?? fileName(c.groupKey);
  };
  const size = choice.sizeBytes + extraFiles.reduce((a, f) => a + f.sizeBytes, 0);

  const download = () =>
    onDownload({
      repo,
      // Exactly the files of this choice (a GGUF quant with its parts, a model folder, an artifact with its checks).
      files: [...choice.files.map((f) => f.path), ...extraFiles.map((f) => f.path)],
      label: `${name} · ${label(choice)}`,
      sizeBytes: size,
      weakKey: choice.weakKey,
      sha256: [...choice.files].sort((a, b) => a.path.localeCompare(b.path))[0]?.sha256,
    });

  return (
    <div className="flex flex-col gap-4">
      <R.Root value={selected} onValueChange={setPicked} aria-label={`${t('models.detail.chooseTitle')}: ${t(`models.detail.sections.${format}`)}`} className="flex flex-col gap-1.5">
        {fit.choices.map((c) => {
          const folder = folderOf(c);
          const first = c.files[0] as HubFile;
          const old = c.manifest?.containerVersion !== undefined && c.manifest.containerVersion !== NINFER_CONTAINER_VERSION;
          return (
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
              <span className="flex min-w-24 flex-col">
                <span className="font-semibold text-fg">{label(c)}</span>
                {folder && (
                  <span className="inline-flex items-center gap-1 font-mono text-2xs text-fg-3">
                    <FolderTree aria-hidden className="size-3" />
                    {t('models.detail.folder', { dir: folder })}
                  </span>
                )}
              </span>
              <span className="text-fg-2 tabular-nums">{bytes(c.sizeBytes)}</span>
              {format === 'gguf' && c.files.length > 1 && <span className="text-xs text-fg-3">{t('models.detail.parts', { n: c.files.length })}</span>}
              {c.manifest && c.manifest.components.length > 0 && <span className="text-xs text-fg-3">{t('models.detail.components', { list: c.manifest.components.join(', ') })}</span>}
              <span className="ml-auto flex flex-wrap items-center gap-1.5">
                {c.groupKey === fit.best && !unsupported && (
                  <Badge tone="accent" size="sm">
                    <Sparkles aria-hidden />
                    {t('models.detail.best')}
                  </Badge>
                )}
                {format === 'gguf' && <ForkBadge model={{ displayName: name, repo, file: fileName(first.path), quant: c.quant }} weakKey={c.weakKey} label={`${name} ${label(c)}`} />}
                {unsupported && (
                  <Badge tone="warning" size="sm">
                    {t('models.needs5090')}
                  </Badge>
                )}
                {old && (
                  <Badge tone="warning" size="sm">
                    {t('models.detail.container', { v: c.manifest?.containerVersion as number, need: NINFER_CONTAINER_VERSION })}
                  </Badge>
                )}
                <FitBadge level={c.fit.level} detail={detail(c.fit)} size="sm" />
                <TriedFor weakKey={c.weakKey} />
              </span>
            </R.Item>
          );
        })}
      </R.Root>
      {extras.length > 0 && format === 'gguf' && (
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
        <p className="max-w-prose text-sm text-fg-2">{format === 'ninfer' ? t('fit.approximate') : t(`fit.hint.${choice.fit.level}`)}</p>
        <Button variant="primary" size="lg" className="ml-auto" onClick={download}>
          <Download aria-hidden />
          {t('models.detail.download', { quant: label(choice), size: bytes(size) })}
        </Button>
      </div>
    </div>
  );
}
