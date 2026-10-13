import { Download, HardDrive, Info, Sparkles } from 'lucide-react';
import { RadioGroup } from 'radix-ui';
import type { ReactNode } from 'react';
import type { EngineKind } from '../../../contract/engines';
import type { RunSummary } from '../../../contract/results';
import { useI18n } from '../../i18n';
import { cn } from '../../lib/cn';
import { useLocalFit } from '../../lib/queries-runs';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Dialog, DialogClose, DialogContent } from '../ui/dialog';
import { EmptyState } from '../ui/empty-state';
import { FitBadge } from '../ui/fit-badge';
import { TriedHereBadge } from '../ui/tried-badge';
import { ForkBadge } from '../library/formats';
import { formatNoteOf, triedHere, triedOn, type ModelOption } from './model-options';

export interface BenchModelPickerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  options: readonly ModelOption[];
  value: string;
  onChange: (key: string) => void;
  engine: EngineKind;
  runs: readonly RunSummary[];
  gpuName: string | undefined;
  description: string;
  onOpenModels: () => void;
}

/** VRAM verdict of a local model for the chosen engine (curated ones are picked to fit this card). */
function RowFit({ option, engine }: { option: ModelOption; engine: EngineKind }) {
  const { t } = useI18n();
  const fit = useLocalFit(option.source === 'local' ? option.local.id : undefined, engine, undefined);
  if (option.source === 'curated') {
    return (
      <Badge tone="accent" size="sm">
        <Sparkles aria-hidden />
        {option.preset ? t('presets.badge') : t('benchmark.pickModel.suggested')}
      </Badge>
    );
  }
  return fit.data ? <FitBadge level={fit.data.level} size="sm" /> : null;
}

function Row({ o, engine, runs, gpuName }: { o: ModelOption; engine: EngineKind; runs: readonly RunSummary[]; gpuName: string | undefined }) {
  const { t, bytes, number } = useI18n();
  const tried = triedOn(o, runs, gpuName);
  return (
    <RadioGroup.Item
      value={o.key}
      className={cn(
        'group flex w-full items-center gap-4 rounded-lg border border-border bg-surface px-4 py-3 text-left transition-colors hover:border-border-strong focus-ring',
        'data-[state=checked]:border-accent data-[state=checked]:bg-accent-soft/40 data-[state=checked]:ring-1 data-[state=checked]:ring-accent',
      )}
    >
      <span
        aria-hidden
        className="grid size-4 shrink-0 place-items-center rounded-full border border-border-strong group-data-[state=checked]:border-accent group-data-[state=checked]:bg-accent-solid"
      >
        <span className="size-1.5 rounded-full bg-white opacity-0 group-data-[state=checked]:opacity-100" />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="flex flex-wrap items-baseline gap-x-2">
          <span className="font-semibold text-fg">{o.name}</span>
          <span className="text-sm text-fg-3">
            {[o.quant, o.paramsB ? t('benchmark.pickModel.params', { n: number(o.paramsB, 1) }) : undefined].filter(Boolean).join(' · ')}
          </span>
        </span>
        {o.source === 'local' && o.sub && (
          <span className="truncate font-mono text-xs text-fg-3" title={o.sub}>
            {o.sub}
          </span>
        )}
        <span className="flex flex-wrap items-center gap-1.5">
          <RowFit option={o} engine={engine} />
          {tried && <TriedHereBadge tried={triedHere(tried)} short size="sm" />}
          {o.source === 'local' && o.local.identity.format === 'gguf' && <ForkBadge model={o.local.identity} weakKey={o.local.identity.weakKey} label={o.name} />}
        </span>
      </span>
      <span className="flex shrink-0 flex-col items-end gap-0.5 text-sm tabular-nums">
        {o.sizeBytes !== undefined && <span className="font-medium text-fg">{bytes(o.sizeBytes)}</span>}
        {o.source === 'local' ? (
          <span className="inline-flex items-center gap-1 text-xs text-fg-3">
            <HardDrive aria-hidden className="size-3" />
            {t('benchmark.modelLocal')}
          </span>
        ) : o.curated.engine === 'vllm' ? (
          <span className="inline-flex items-center gap-1 text-xs text-fg-3">
            <Download aria-hidden className="size-3" />
            {t('benchmark.modelFromHub')}
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 text-xs text-accent-text">
            <Download aria-hidden className="size-3" />
            {t('benchmark.pickModel.toDownload')}
          </span>
        )}
      </span>
    </RadioGroup.Item>
  );
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-xs font-semibold tracking-wide text-fg-3 uppercase">{title}</h3>
      {children}
    </div>
  );
}

/** Model chooser: what is on the PC first, then curated suggestions, each with its VRAM verdict. */
export function BenchModelPicker({ open, onOpenChange, options, value, onChange, engine, runs, gpuName, description, onOpenModels }: BenchModelPickerProps) {
  const { t } = useI18n();
  const local = options.filter((o) => o.source === 'local');
  const remote = options.filter((o) => o.source === 'curated');
  const note = formatNoteOf(engine);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        size="lg"
        title={t('benchmark.pickModel.title')}
        description={description}
        footer={
          <>
            <Button variant="ghost" onClick={onOpenModels}>
              {t('benchmark.pickModel.more')}
            </Button>
            <DialogClose asChild>
              <Button variant="primary">{t('common.confirm')}</Button>
            </DialogClose>
          </>
        }
      >
        {/* Why this engine lists other models than another one: each reads its own format. */}
        {note && (
          <p className="mb-4 flex items-start gap-2 rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm text-fg-2">
            <Info aria-hidden className="mt-0.5 size-4 shrink-0 text-fg-3" />
            {t(`models.picker.formatNote.${note}`)}
          </p>
        )}
        {options.length === 0 ? (
          <EmptyState headingLevel={3} illustration="search" title={t('benchmark.pickModel.emptyTitle')} description={t('benchmark.pickModel.emptyBody')} />
        ) : (
          <RadioGroup.Root value={value} onValueChange={onChange} aria-label={t('benchmark.choice.model')} className="flex flex-col gap-5">
            {local.length > 0 && (
              <Group title={t('benchmark.pickModel.local')}>
                {local.map((o) => (
                  <Row key={o.key} o={o} engine={engine} runs={runs} gpuName={gpuName} />
                ))}
              </Group>
            )}
            {remote.length > 0 && (
              <Group title={t('benchmark.pickModel.recommended')}>
                {remote.map((o) => (
                  <Row key={o.key} o={o} engine={engine} runs={runs} gpuName={gpuName} />
                ))}
              </Group>
            )}
          </RadioGroup.Root>
        )}
      </DialogContent>
    </Dialog>
  );
}
