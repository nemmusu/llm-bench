/** useModelRecipe for the Server page's slot (any identity), and the applied-recipe line. */
import { screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { customEngineSchema } from '../../../../src/contract/custom-engines';
import { modelRecipeSchema, type RecipeModelRef } from '../../../../src/contract/recipes';
import { AppliedRecipeLine } from '../../../../src/renderer/components/recipes/recipe-chip';
import { useModelRecipe } from '../../../../src/renderer/components/recipes/use-model-recipe';
import { fakeApi, renderUi } from '../helpers';

function Probe({ model }: { model: RecipeModelRef | undefined }) {
  const r = useModelRecipe(model);
  return (
    <output>
      {JSON.stringify({ name: r.recipe?.name, label: r.label, engine: r.engine, missing: r.missingTemplate, off: r.requestPart(false), on: r.requestPart(true), patch: r.launchPatch('vllm-docker')?.params })}
    </output>
  );
}

const read = () => JSON.parse(screen.getByRole('status').textContent as string) as Record<string, unknown>;

describe('useModelRecipe', () => {
  const fork = customEngineSchema.parse({ id: 'f', name: 'Il fork', base: 'llamacpp', run: { mode: 'docker', image: 'me/fork:1' } });
  const recipes = [
    modelRecipeSchema.parse({ id: 'a', name: 'Fork', match: { name: 'alpha' }, engine: { type: 'custom', id: 'f' }, contextSize: 65_536 }),
    modelRecipeSchema.parse({ id: 'b', name: 'Built-in', match: { name: 'beta' }, engine: { type: 'builtin', kind: 'vllm-native' } }),
    modelRecipeSchema.parse({ id: 'c', name: 'Template', match: { name: 'gamma' }, engine: { type: 'template', template: 'prismml-bonsai' } }),
  ];

  it('any identity: the recipe, its words, its engine as a config, the request part and what it adds', async () => {
    renderUi(<Probe model={{ displayName: 'alpha 8B' }} />, { withSettings: true, api: fakeApi({ modelRecipes: recipes, customEngines: [fork] }) });
    await waitFor(() => expect(read()).toEqual({ name: 'Fork', label: 'Il fork · Contesto 64K', engine: { kind: 'llamacpp-docker', customEngineId: 'f' }, off: { recipe: { use: false } }, on: {}, patch: { maxModelLen: 65_536 } }));
  });

  it('a built-in engine; a template not set up yet; no recipe at all', async () => {
    const api = fakeApi({ modelRecipes: recipes });
    const first = renderUi(<Probe model={{ displayName: 'beta' }} />, { withSettings: true, api });
    await waitFor(() => expect(read()).toMatchObject({ engine: { kind: 'vllm-native' } }));
    first.unmount();
    const second = renderUi(<Probe model={{ displayName: 'gamma' }} />, { withSettings: true, api });
    await waitFor(() => expect(read()).toMatchObject({ missing: 'prismml-bonsai', label: 'Fork PrismML (da indicare)' }));
    second.unmount();
    renderUi(<Probe model={undefined} />, { withSettings: true, api });
    await waitFor(() => expect(read()).toEqual({ off: {}, on: {} }));
  });
});

describe('AppliedRecipeLine', () => {
  it('nothing without a recipe; the parts left out are said', () => {
    const { container } = renderUi(<AppliedRecipeLine applied={undefined} />);
    expect(container.textContent).toBe('');
    renderUi(<AppliedRecipeLine applied={{ id: 'r', name: 'R', from: [], parts: ['args'], args: ['--x'], envNames: [], overridden: [], skipped: [{ part: 'draft', reason: 'engine' }] }} />);
    expect(screen.getByText('Usa i comandi «R»: argomenti')).toBeTruthy();
    expect(screen.getByText('Non usati qui: MTP (non per questo motore)')).toBeTruthy();
  });
});
