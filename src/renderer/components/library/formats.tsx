import { Link } from '@tanstack/react-router';
import { Cpu, FileBox, Layers, Package, Wrench } from 'lucide-react';
import { templateForModel, type MatchableModel } from '../../../contract/custom-engines';
import type { HubModel } from '../../../contract/models';
import { useI18n } from '../../i18n';
import { cn } from '../../lib/cn';
import { Badge } from '../ui/badge';
import { Tooltip } from '../ui/tooltip';

/**
 * Engines the catalog filters by. vLLM and SGLang read the same safetensors folders; NInfer reads
 * .ninfer artifacts (RTX 5090 only); llama.cpp reads GGUF.
 */
export const ENGINE_FILTERS = ['gguf', 'vllm', 'sglang', 'ninfer', 'any'] as const;
export type EngineFilter = (typeof ENGINE_FILTERS)[number];

/** The format a search asks the core for. */
export type CatalogFormat = 'gguf' | 'safetensors' | 'ninfer' | 'any';

export function formatOfEngine(e: EngineFilter): CatalogFormat {
  return e === 'vllm' || e === 'sglang' ? 'safetensors' : e;
}

/** Model formats as the badges show them. */
export type ModelFormat = 'gguf' | 'safetensors' | 'ninfer';

const ICONS = { gguf: Layers, safetensors: Package, ninfer: Cpu } as const;

/** NInfer runs on an RTX 5090 only. */
export function isRtx5090(gpuName: string | undefined): boolean {
  return /rtx\s*5090/i.test(gpuName ?? '');
}

/**
 * One format as a badge with the engine that runs it: "GGUF · llama.cpp", "Safetensors · vLLM / SGLang · FP8",
 * "NInfer · solo RTX 5090". `active`: the format the catalog filter asks for (drawn stronger).
 */
export function FormatBadge({ format, precision, active, size = 'sm' }: { format: ModelFormat; precision?: string | undefined; active?: boolean; size?: 'sm' | 'md' }) {
  const { t } = useI18n();
  const Icon = ICONS[format];
  return (
    <Tooltip content={t(`models.formats.help.${format}`)}>
      <Badge tone={active ? 'accent' : 'outline'} size={size} data-format={format} className="relative z-10">
        <Icon aria-hidden />
        <span className="font-semibold">{t(`models.formats.${format}`)}</span>
        <span aria-hidden className="opacity-60">
          ·
        </span>
        <span>{t(`models.formats.engine.${format}`)}</span>
        {precision && (
          <>
            <span aria-hidden className="opacity-60">
              ·
            </span>
            <span className="font-mono">{precision}</span>
          </>
        )}
      </Badge>
    </Tooltip>
  );
}

/**
 * A format GPU Bench cannot run (MLX, ONNX, EXL2…): shown, marked as not supported. `module`: an MTP head
 * or a draft shipped as its own folder, a part of a model rather than a format.
 */
export function OtherFormatBadge({ name, module, size = 'sm' }: { name?: string | undefined; module?: boolean; size?: 'sm' | 'md' }) {
  const { t } = useI18n();
  return (
    <Tooltip content={t('models.formats.help.other')}>
      <Badge tone="neutral" size={size} data-format="other" className="relative z-10 text-fg-3">
        <FileBox aria-hidden />
        <span>{name ?? t('models.formats.other')}</span>
        <span aria-hidden className="opacity-60">
          ·
        </span>
        <span>{module ? t('models.formats.module') : t('models.formats.unsupported')}</span>
      </Badge>
    </Tooltip>
  );
}

/** Every format a hub repo ships, each with its engine; the one the filter asks for first and stronger. */
export function FormatBadges({ m, engine, className }: { m: Pick<HubModel, 'formats' | 'precision' | 'otherFormats'>; engine?: EngineFilter; className?: string }) {
  const asked = engine ? formatOfEngine(engine) : 'any';
  const runnable = (['gguf', 'safetensors', 'ninfer'] as const).filter((f) => m.formats.includes(f)).sort((a, b) => Number(b === asked) - Number(a === asked));
  return (
    <span className={cn('flex flex-wrap items-center gap-1.5', className)}>
      {runnable.map((f) => (
        <FormatBadge key={f} format={f} precision={f === 'safetensors' ? m.precision : undefined} active={f === asked} />
      ))}
      {m.otherFormats.map((o) => (
        <OtherFormatBadge key={o} name={o} />
      ))}
      {m.formats.includes('other') && m.otherFormats.length === 0 && <OtherFormatBadge />}
    </span>
  );
}

/**
 * "Richiede il fork PrismML di llama.cpp" next to models only a custom engine reads (PrismML's ternary
 * Bonsai quants): one click opens the Engines page with that engine ready to set up.
 */
export function ForkBadge({ model, weakKey, label }: { model: MatchableModel; weakKey?: string | undefined; label?: string | undefined }) {
  const { t } = useI18n();
  const template = templateForModel(model);
  if (!template) return null;
  const name = t(`models.fork.names.${template.id as 'prismml-bonsai'}`);
  // The Engines page reads these (its own route search); an unknown template just opens the page.
  const search = { customTemplate: template.id, ...(weakKey ? { model: weakKey } : {}), ...(label ? { modelName: label } : {}) };
  return (
    <Link
      to="/engines"
      search={search as never}
      className="relative z-10 inline-flex rounded-full focus-ring"
      aria-label={`${t('models.fork.requires', { name })} · ${t('models.fork.action')}`}
    >
      <Badge tone="warning" size="sm" className="hover:brightness-95">
        <Wrench aria-hidden />
        {t('models.fork.requires', { name })}
      </Badge>
    </Link>
  );
}
