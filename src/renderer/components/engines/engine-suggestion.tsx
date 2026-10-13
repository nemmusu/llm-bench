import { useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { customEngineConfigOf, customEngineForModel, templateForModel, type CustomEngine, type MatchableModel } from '../../../contract/custom-engines';
import type { EngineConfig } from '../../../contract/engines';
import type { RunSummary } from '../../../contract/results';
import { useI18n, type MessageKey } from '../../i18n';
import { Button } from '../ui/button';
import { Callout } from '../ui/callout';

/** The weight layouts or formats an engine could not read for this model in earlier runs ("gguf_blocks_v1"), if any. */
export function unreadableFor(runs: readonly Pick<RunSummary, 'modelWeakKey' | 'unreadable'>[] | undefined, weakKey: string): string[] | undefined {
  const seen = (runs ?? []).flatMap((r) => (r.modelWeakKey === weakKey && r.unreadable !== undefined ? [r.unreadable] : []));
  return seen.length ? [...new Set(seen)] : undefined;
}

export interface EngineSuggestionProps {
  /** The chosen model (its repo, file, name and quant are what the rules look at). */
  model: (MatchableModel & { weakKey?: string | undefined }) | undefined;
  /** The engine chosen now. */
  current: Pick<EngineConfig, 'kind' | 'customEngineId'>;
  engines: readonly CustomEngine[];
  /** Switches the Benchmark to a saved engine. */
  onUse: (config: EngineConfig) => void;
}

/**
 * LLM Bench's suggestion for the chosen model, never a choice made for the user: a saved engine
 * whose rules match ("Per questo modello c'è PrismML fork · Usa"), or, when none does, the built-in
 * template the model needs ("Questo modello richiede il fork PrismML di llama.cpp · Indica dove si
 * trova · Scopri di più").
 */
export function EngineSuggestion({ model, current, engines, onUse }: EngineSuggestionProps) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const [more, setMore] = useState(false);
  if (!model) return null;
  const saved = customEngineForModel(engines, model);
  if (saved) {
    if (current.customEngineId === saved.id) return null;
    return (
      <Callout
        tone="info"
        title={t('engines.custom.suggest.matchTitle', { name: saved.name })}
        action={{ label: t('engines.custom.suggest.use', { name: saved.name }), onClick: () => onUse(customEngineConfigOf(saved)) }}
      >
        <p>{t('engines.custom.suggest.matchBody')}</p>
      </Callout>
    );
  }
  const template = templateForModel(model);
  if (!template) return null;
  // A NInfer variant is added (downloaded and built by LLM Bench); a fork is pointed at.
  const variant = template.base === 'ninfer';
  const name = variant ? template.label : t(`engines.custom.templates.${template.id}.inSentence` as MessageKey);
  return (
    <Callout tone="warning" title={variant ? t('ninfer.variant.requiresTitle', { name }) : t('engines.custom.suggest.requiresTitle', { template: name })}>
      <p>{variant ? t('ninfer.variant.requiresBody', { name }) : t('engines.custom.suggest.requiresBody')}</p>
      {more && <p className="mt-1">{t(`engines.custom.templates.${template.id}.explain` as MessageKey)}</p>}
      <div className="mt-2 flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="primary"
          onClick={() =>
            void navigate({
              to: '/engines',
              search: { customTemplate: template.id, ...(model.weakKey ? { model: model.weakKey } : {}), modelName: [model.displayName, model.quant].filter(Boolean).join(' ') },
            })
          }
        >
          {variant ? t('ninfer.variant.add', { name }) : t('engines.custom.suggest.locate')}
        </Button>
        <Button size="sm" variant="ghost" aria-expanded={more} onClick={() => setMore((m) => !m)}>
          {more ? t('engines.custom.suggest.hide') : t('engines.custom.suggest.learnMore')}
        </Button>
      </div>
    </Callout>
  );
}
