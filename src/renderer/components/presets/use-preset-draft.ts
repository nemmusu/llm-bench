/**
 * The Benchmark page's side of a preset: the draft handed over by "Usa questo preset" (read once),
 * its model as a choice when it must be downloaded first, and the banner saying where it came from.
 */
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useState } from 'react';
import type { EngineKind } from '../../../contract/engines';
import type { CuratedModel } from '../../../contract/views';
import { engineFamily, type ModelOption } from '../bench/model-options';
import { takeDraft, type BenchDraft, type DraftHubModel, type PresetProvenance } from '../bench/run-context';

export interface PresetDraft {
  draft: BenchDraft | undefined;
  /** Where the preset came from; undefined without one, or once the banner was closed. */
  provenance: PresetProvenance | undefined;
  dismiss: () => void;
  /** `options` plus the preset's model to download, when it is for this engine and not one of them already. */
  withModel: (options: ModelOption[], engine: EngineKind) => ModelOption[];
  /** The key of the preset's model to download among `options` (undefined without one). */
  modelKey: (options: readonly ModelOption[]) => string | undefined;
}

const sameHub = (o: ModelOption, hub: DraftHubModel): boolean =>
  o.source === 'curated' ? o.curated.repo === hub.repo && o.curated.file === hub.file : o.local.identity.repo === hub.repo && o.local.identity.file === hub.file;

/** The preset's model as a choice "to download", like a suggestion (it is planned and downloaded the same way). */
export function hubOption(hub: DraftHubModel): ModelOption {
  const curated: CuratedModel = {
    id: `preset:${hub.repo}/${hub.file ?? ''}`,
    label: hub.name,
    engine: hub.file === undefined ? 'vllm' : 'llamacpp',
    tier: 0,
    repo: hub.repo,
    ...(hub.file === undefined ? {} : { file: hub.file }),
    revision: hub.revision,
    sizeBytes: hub.sizeBytes ?? 0,
    quant: hub.quant ?? '',
    paramsB: hub.paramsB ?? 0,
    license: '',
  };
  return { key: `curated:${curated.id}`, source: 'curated', name: hub.name, quant: curated.quant, sizeBytes: curated.sizeBytes, paramsB: curated.paramsB, curated, preset: true };
}

export function usePresetDraft(): PresetDraft {
  const qc = useQueryClient();
  const [draft] = useState<BenchDraft | undefined>(() => takeDraft(qc));
  const [dismissed, setDismissed] = useState(false);
  const hub = draft?.hub;
  // Stable for the page's memoized model list: the draft never changes once read.
  const withModel = useCallback(
    (options: ModelOption[], engine: EngineKind) => {
      if (!hub || engineFamily(engine) !== (hub.file === undefined ? 'vllm' : 'llamacpp') || options.some((o) => sameHub(o, hub))) return options;
      return [...options, hubOption(hub)];
    },
    [hub],
  );
  return {
    draft,
    provenance: dismissed ? undefined : draft?.provenance,
    dismiss: () => setDismissed(true),
    withModel,
    modelKey: (options) => (hub ? options.find((o) => sameHub(o, hub))?.key : undefined),
  };
}
