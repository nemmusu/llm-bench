/**
 * "Comandi per questo modello" on the model page (its slot: library/model-detail-slots.tsx). The recipe
 * is for every file of the repo; its built-ins see the repo's trained context (the page's fit) and the
 * extras it ships (MTP, projector). Nothing while the files load, or for a repo with no loadable weights.
 */
import type { RepoLayout } from '../../../contract/formats';
import type { HubFile } from '../../../contract/models';
import { useHubFit } from '../../lib/queries-library';
import { targetOfHub } from './recipe-model';
import { ModelRecipeSection } from './recipe-section';

/** What it reads of the slot's props (ModelDetailSectionProps). */
export interface RecipesSectionProps {
  repo: string;
  layout: RepoLayout<HubFile> | undefined;
}

export function RecipesSection({ repo, layout }: RecipesSectionProps) {
  const format = !layout ? undefined : layout.gguf.weights.length ? 'gguf' : layout.safetensors.length ? 'safetensors' : layout.ninfer.length ? 'ninfer' : undefined;
  // The same queries as the page's own format sections: answered from their cache.
  const fit = useHubFit(repo, format === 'safetensors' ? 'vllm-docker' : format ? 'llamacpp-native' : undefined, format === 'ninfer' ? 'ninfer' : undefined);
  if (!layout || !format) return null;
  const best = fit.data?.choices.find((c) => c.groupKey === fit.data?.best) ?? fit.data?.choices[0];
  const target = targetOfHub({
    repo,
    file: format === 'gguf' ? best?.files[0]?.path : undefined,
    quant: best?.quant,
    format,
    trainedContext: fit.data?.facts.contextLength,
    auxKinds: layout.gguf.extras.map((f) => f.kind as 'mmproj' | 'mtp' | 'draft' | 'other'),
  });
  return <ModelRecipeSection target={target} />;
}
