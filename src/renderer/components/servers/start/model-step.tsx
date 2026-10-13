/** Step 1 of "Avvia un server": the model, chosen in a dialog grouped by what reads it (GGUF, Hugging Face, NInfer). */
import { ChevronsUpDown, Download, HardDrive } from 'lucide-react';
import { RadioGroup } from 'radix-ui';
import { useState } from 'react';
import type { EngineKind } from '../../../../contract/engines';
import { useI18n } from '../../../i18n';
import { cn } from '../../../lib/cn';
import { useLocalFit } from '../../../lib/queries-runs';
import type { ModelOption } from '../../bench/model-options';
import { Badge } from '../../ui/badge';
import { Button } from '../../ui/button';
import { Dialog, DialogContent } from '../../ui/dialog';
import { FitBadge } from '../../ui/fit-badge';
import { optionFormat, type ModelFormat } from '../server-flow';

const FORMATS: readonly ModelFormat[] = ['gguf', 'safetensors', 'ninfer'];
/** The engine a format's fit verdict is asked for. */
const FIT_ENGINE: Record<ModelFormat, EngineKind> = { gguf: 'llamacpp-native', safetensors: 'vllm-docker', ninfer: 'ninfer-native' };

function Row({ o }: { o: ModelOption }) {
  const { t, bytes } = useI18n();
  const format = optionFormat(o);
  const fit = useLocalFit(o.source === 'local' ? o.local.id : undefined, FIT_ENGINE[format], undefined);
  const detail = [o.quant, o.sizeBytes === undefined ? undefined : bytes(o.sizeBytes)].filter(Boolean).join(' · ');
  return (
    <RadioGroup.Item
      value={o.key}
      aria-label={`${o.name}${o.quant ? ` ${o.quant}` : ''}`}
      className={cn(
        'group flex w-full items-center gap-3 rounded-lg border border-border bg-surface px-3 py-2.5 text-left transition-colors hover:border-border-strong focus-ring',
        'data-[state=checked]:border-accent data-[state=checked]:bg-accent-soft/40 data-[state=checked]:ring-1 data-[state=checked]:ring-accent',
      )}
    >
      {o.source === 'local' ? <HardDrive aria-hidden className="size-4 shrink-0 text-fg-3" /> : <Download aria-hidden className="size-4 shrink-0 text-accent-text" />}
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm font-medium text-fg">{o.name}</span>
        <span className="text-xs text-fg-3 tabular-nums">{detail}</span>
      </span>
      {o.source === 'curated' ? (
        <Badge tone="accent" size="sm">
          {t('servers.flow.model.suggested')}
        </Badge>
      ) : (
        fit.data && <FitBadge level={fit.data.level} size="sm" />
      )}
    </RadioGroup.Item>
  );
}

export interface ModelStepProps {
  options: readonly ModelOption[];
  value: ModelOption | undefined;
  onChange: (key: string) => void;
  onOpenModels: () => void;
}

export function ModelStep({ options, value, onChange, onOpenModels }: ModelStepProps) {
  const { t, bytes } = useI18n();
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<string | undefined>(undefined);
  if (!value) {
    return (
      <div className="flex flex-col items-start gap-2">
        <p className="text-sm font-medium text-fg">{t('servers.flow.model.none')}</p>
        <p className="text-sm text-fg-2">{t('servers.flow.model.noneBody')}</p>
        <Button size="sm" onClick={onOpenModels}>
          {t('servers.flow.model.openModels')}
        </Button>
      </div>
    );
  }
  const detail = [value.quant, value.sizeBytes === undefined ? undefined : bytes(value.sizeBytes)].filter(Boolean).join(' · ');
  return (
    <>
      <button
        type="button"
        onClick={() => {
          setPicked(value.key);
          setOpen(true);
        }}
        aria-label={t('servers.flow.model.change', { name: `${value.name}${value.quant ? ` ${value.quant}` : ''}` })}
        className="flex items-center gap-3 rounded-lg border border-border-strong bg-surface px-3 py-2 text-left shadow-xs transition-colors hover:bg-surface-2 focus-ring"
      >
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-md font-semibold text-fg">{value.name}</span>
          <span className="truncate text-sm text-fg-3 tabular-nums">{detail}</span>
        </span>
        <ChevronsUpDown aria-hidden className="size-4 shrink-0 text-fg-3" />
      </button>
      {value.source === 'curated' && (
        <p className="inline-flex items-center gap-1.5 text-sm text-accent-text">
          <Download aria-hidden className="size-4" />
          {t('servers.flow.model.suggested')}
        </p>
      )}
      <Dialog open={open} onOpenChange={setOpen}>
        {open && (
          <DialogContent
            size="lg"
            title={t('servers.flow.model.pick')}
            description={t('servers.flow.model.pickDescription')}
            footer={
              <>
                <Button onClick={() => setOpen(false)}>{t('common.cancel')}</Button>
                <Button
                  variant="primary"
                  onClick={() => {
                    onChange(picked!);
                    setOpen(false);
                  }}
                >
                  {t('servers.flow.model.confirm')}
                </Button>
              </>
            }
          >
            <RadioGroup.Root value={picked} onValueChange={setPicked} aria-label={t('servers.flow.model.pick')} className="flex flex-col gap-4">
              {FORMATS.map((format) => {
                const rows = options.filter((o) => optionFormat(o) === format);
                if (!rows.length) return null;
                return (
                  <div key={format} className="flex flex-col gap-1.5">
                    <p className="text-xs font-semibold tracking-wide text-fg-3 uppercase">{t(`servers.flow.model.format.${format}`)}</p>
                    {rows.map((o) => (
                      <Row key={o.key} o={o} />
                    ))}
                  </div>
                );
              })}
            </RadioGroup.Root>
          </DialogContent>
        )}
      </Dialog>
    </>
  );
}
