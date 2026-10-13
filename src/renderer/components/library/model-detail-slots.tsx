import type { ComponentType } from 'react';
import type { RepoLayout } from '../../../contract/formats';
import type { HubFile } from '../../../contract/models';
import type { HubRepoInfo } from '../../../contract/views';
import { RecipesSection } from '../recipes/recipes-section';

/** What a section added to the model page receives. */
export interface ModelDetailSectionProps {
  /** "owner/name" of the hub repo. */
  repo: string;
  /** The repo's card data; undefined while loading (or when the hub does not answer). */
  info: HubRepoInfo | undefined;
  /** Every file of the repo; undefined while loading. */
  files: HubFile[] | undefined;
  /** The files split by format (GGUF, safetensors folders, NInfer artifacts, other); undefined while loading. */
  layout: RepoLayout<HubFile> | undefined;
}

/** A section another feature adds to the model page, below the download sections ("Comandi per questo modello"…). */
export interface ModelDetailSection {
  /** Stable id: React key and `data-section` of its wrapper (tests, mockups). */
  id: string;
  /** Lower comes first. */
  order: number;
  Component: ComponentType<ModelDetailSectionProps>;
}

/**
 * The model page's open slot. A feature adds itself here with one entry, without touching the page:
 *   import { RecipesSection } from '../recipes/recipes-section';
 *   { id: 'recipes', order: 10, Component: RecipesSection },
 * Each Component renders its own Card (or nothing, when it has nothing to say for this repo).
 */
export const MODEL_DETAIL_SECTIONS: ModelDetailSection[] = [{ id: 'recipes', order: 10, Component: RecipesSection }];

/** Renders the added sections in order, in the page's main column. */
export function ModelDetailSlots({ sections = MODEL_DETAIL_SECTIONS, ...props }: ModelDetailSectionProps & { sections?: readonly ModelDetailSection[] }) {
  return (
    <>
      {[...sections]
        .sort((a, b) => a.order - b.order)
        .map(({ id, Component }) => (
          <div key={id} data-section={id} className="contents">
            <Component {...props} />
          </div>
        ))}
    </>
  );
}
