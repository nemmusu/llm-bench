import { Download, HardDrive } from 'lucide-react';
import { RadioGroup } from 'radix-ui';
import type { ReactNode } from 'react';
import { useI18n } from '../../i18n';
import { cn } from '../../lib/cn';
import type { ModelChoice } from '../../mock/models';
import { Button } from '../ui/button';
import { Dialog, DialogClose, DialogContent } from '../ui/dialog';
import { FitBadge } from '../ui/fit-badge';
import { TriedBadge } from '../ui/tried-badge';

export interface ModelPickerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  models: readonly ModelChoice[];
  value: string;
  onChange: (id: string) => void;
  gpuName: string;
  vram: string;
}

function Row({ m }: { m: ModelChoice }) {
  const { t, bytes, number } = useI18n();
  return (
    <RadioGroup.Item
      value={m.id}
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
          <span className="font-semibold text-fg">{m.name}</span>
          <span className="text-sm text-fg-3">
            {m.quant} · {t('benchmark.pickModel.params', { n: number(m.paramsB, 1) })}
          </span>
        </span>
        <span className="flex flex-wrap items-center gap-1.5">
          <FitBadge level={m.fit} size="sm" />
          {m.tried && <TriedBadge tps={m.tried.tps} date={m.tried.date} short size="sm" />}
        </span>
      </span>
      <span className="flex shrink-0 flex-col items-end gap-0.5 text-sm tabular-nums">
        <span className="font-medium text-fg">{bytes(m.sizeBytes)}</span>
        {m.local ? (
          <span className="inline-flex items-center gap-1 text-xs text-fg-3">
            <HardDrive aria-hidden className="size-3" />
            {t('benchmark.modelLocal')}
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 text-xs text-accent-text">
            <Download aria-hidden className="size-3" />
            {t('benchmark.modelToDownload', { size: bytes(m.sizeBytes) })}
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

/** Model chooser: what is on the PC first, then curated downloads, each with its VRAM verdict. */
export function ModelPicker({ open, onOpenChange, models, value, onChange, gpuName, vram }: ModelPickerProps) {
  const { t } = useI18n();
  const local = models.filter((m) => m.local);
  const remote = models.filter((m) => !m.local);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        size="lg"
        title={t('benchmark.pickModel.title')}
        description={t('benchmark.pickModel.description', { gpu: gpuName, vram })}
        footer={
          <DialogClose asChild>
            <Button variant="primary">{t('common.confirm')}</Button>
          </DialogClose>
        }
      >
        <RadioGroup.Root value={value} onValueChange={onChange} aria-label={t('benchmark.choice.model')} className="flex flex-col gap-5">
          <Group title={t('benchmark.pickModel.local')}>
            {local.map((m) => (
              <Row key={m.id} m={m} />
            ))}
          </Group>
          <Group title={t('benchmark.pickModel.recommended')}>
            {remote.map((m) => (
              <Row key={m.id} m={m} />
            ))}
          </Group>
        </RadioGroup.Root>
      </DialogContent>
    </Dialog>
  );
}
