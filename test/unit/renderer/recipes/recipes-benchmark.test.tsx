/**
 * The model's commands on the Benchmark page (the chip, expert mode, "Avvia solo il server"), the YaRN
 * option of expert mode and of "Trova le impostazioni migliori", what a result says it applied.
 */
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { StartRunRequest, StartServerRequest } from '../../../../src/contract/api';
import { customEngineSchema } from '../../../../src/contract/custom-engines';
import { modelRecipeSchema, type ModelRecipe } from '../../../../src/contract/recipes';
import { renderApp } from '../helpers';
import { benchApi, localModel, planFor } from '../bench/world';

vi.mock('echarts/core', () => ({ use: vi.fn(), init: vi.fn(() => ({ setOption: vi.fn(), resize: vi.fn(), dispose: vi.fn() })) }));
vi.mock('echarts/charts', () => ({ LineChart: {}, BarChart: {} }));
vi.mock('echarts/components', () => ({ AxisPointerComponent: {}, DataZoomComponent: {}, GridComponent: {}, LegendComponent: {}, MarkAreaComponent: {}, MarkLineComponent: {}, TooltipComponent: {} }));
vi.mock('echarts/renderers', () => ({ CanvasRenderer: {} }));

beforeAll(() => {
  Object.assign(Element.prototype, { hasPointerCapture: () => false, releasePointerCapture: () => undefined, scrollIntoView: () => undefined });
});
afterEach(() => {
  delete (window as { gpubench?: unknown }).gpubench;
});

/** The world's first model, trained on 40K tokens. */
const QWEN = localModel('qwen3-8b', { facts: { name: 'qwen3-8b model', paramsB: 8, blockCount: 36, contextLength: 40_960 } });
const recipe = (over: Record<string, unknown> = {}): ModelRecipe =>
  modelRecipeSchema.parse({
    id: 'q-yarn',
    name: 'Qwen YaRN',
    match: { models: [], name: 'qwen3-8b' },
    contextSize: 307_200,
    ropeScaling: { type: 'yarn', factor: 7.5, originalContext: 40_960 },
    args: { llamacpp: ['--jinja', '--rope-scale', '7.5'] },
    env: { GGML_X: '1' },
    ...over,
  });
const posted = (api: ReturnType<typeof benchApi>, path: string) => api.calls.filter((c) => c.method === 'POST' && c.path === path).map((c) => c.body);
const lastPlan = (api: ReturnType<typeof benchApi>) => posted(api, '/api/runs/plan').at(-1) as StartRunRequest;

describe('the Benchmark chip', () => {
  it('says the model’s commands; off sends { use: false } to the plan, the run and the server', async () => {
    const api = benchApi({ local: [QWEN] }, { onboardingDone: true, modelRecipes: [recipe()] });
    renderApp('/', api);
    const chip = (await screen.findByText('Usa i comandi di questo modello')).closest('div.rounded-lg') as HTMLElement;
    expect(within(chip).getByText('YaRN 300K')).toBeTruthy();
    expect(within(chip).getByText('3 argomenti')).toBeTruthy();
    expect(within(chip).getByText('1 variabile')).toBeTruthy();
    expect(within(chip).getByText('Qwen YaRN')).toBeTruthy();
    // On: the core applies it by itself, the request says nothing.
    await waitFor(() => expect(posted(api, '/api/runs/plan').length).toBeGreaterThan(0));
    expect(lastPlan(api).recipe).toBeUndefined();
    await userEvent.click(within(chip).getByRole('switch', { name: 'Usa i comandi di questo modello' }));
    expect(within(chip).getByText('Il test parte con le impostazioni normali, senza i comandi di questo modello.')).toBeTruthy();
    await waitFor(() => expect(lastPlan(api).recipe).toEqual({ use: false }));
    await userEvent.click(screen.getByRole('button', { name: 'Avvia solo il server' }));
    await screen.findByRole('dialog', { name: 'Avvia il server' });
    expect((posted(api, '/api/servers/plan').at(-1) as StartServerRequest).recipe).toEqual({ use: false });
  });

  it('"Apri" opens the recipe; a model picker badge says which models have one', async () => {
    const api = benchApi({ local: [QWEN] }, { onboardingDone: true, modelRecipes: [recipe()] });
    renderApp('/', api);
    await userEvent.click(await screen.findByRole('button', { name: 'Apri: Qwen YaRN' }));
    expect(await screen.findByRole('dialog', { name: 'Modifica i comandi' })).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Annulla' }));
    await userEvent.click(screen.getByRole('button', { name: /^Cambia modello/ }));
    const picker = await screen.findByRole('dialog', { name: 'Scegli un modello' });
    expect(within(picker).getByText('Comandi: Qwen YaRN')).toBeTruthy();
  });

  it('a fork still to set up: the chip says so and leads to the Engines page', async () => {
    const api = benchApi({ local: [QWEN] }, { onboardingDone: true, modelRecipes: [recipe({ contextSize: undefined, ropeScaling: undefined, args: {}, env: {}, engine: { type: 'template', template: 'prismml-bonsai' } })] });
    const { router } = renderApp('/', api);
    expect(await screen.findByText('Fork PrismML (da indicare)')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Indica dove si trova il fork' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/engines'));
    expect(router.state.location.search).toMatchObject({ customTemplate: 'prismml-bonsai', model: QWEN.identity.weakKey });
  });

  it('a recipe with nothing to show still names itself; applied lines without a recipe are nothing', async () => {
    const api = benchApi({ local: [QWEN] }, { onboardingDone: true, modelRecipes: [recipe({ contextSize: undefined, ropeScaling: undefined, args: {}, env: {}, notes: 'solo note' })] });
    renderApp('/', api);
    const chip = (await screen.findByText('Usa i comandi di questo modello')).closest('div.rounded-lg') as HTMLElement;
    expect(within(chip).getAllByText('Qwen YaRN')).toHaveLength(2);
  });

  it('a saved fork or a built-in engine: said by name; no recipe, no chip', async () => {
    const fork = customEngineSchema.parse({ id: 'f', name: 'Il fork', base: 'llamacpp', run: { mode: 'native', path: '/f' } });
    const api = benchApi({ local: [QWEN] }, { onboardingDone: true, customEngines: [fork], modelRecipes: [recipe({ engine: { type: 'custom', id: 'f' } })] });
    renderApp('/', api);
    expect(await screen.findByText('Il fork')).toBeTruthy();
    const plain = benchApi({ local: [QWEN] }, { onboardingDone: true, modelRecipes: [recipe({ match: { name: 'llama' } })] });
    renderApp('/', plain);
    await waitFor(() => expect(posted(plain, '/api/runs/plan').length).toBeGreaterThan(0));
    expect(screen.queryAllByText('Usa i comandi di questo modello')).toHaveLength(1);
  });
});

describe('expert mode with the model’s commands', () => {
  it('the recipe’s values where the user’s would go; the user’s own replace them, and it is said', async () => {
    const api = benchApi({ local: [QWEN] }, { onboardingDone: true, expertMode: true, modelRecipes: [recipe()] });
    renderApp('/', api);
    const ctx = (await screen.findByLabelText('Contesto (token)')) as HTMLInputElement;
    await waitFor(() => expect(ctx.placeholder).toBe('307.200 dalla ricetta'));
    expect(screen.getByText('Dalla ricetta «Qwen YaRN»')).toBeTruthy();
    expect(screen.getByText('Dalla ricetta «Qwen YaRN»: YaRN 300K')).toBeTruthy();
    const box = screen.getByLabelText('Dalla ricetta «Qwen YaRN»');
    expect(within(box).getByText('Prima dei tuoi argomenti, la ricetta «Qwen YaRN» aggiunge:')).toBeTruthy();
    expect(within(box).getByText('--rope-scale 7.5').className).not.toContain('line-through');
    await userEvent.type(ctx, '8192');
    expect(screen.getByText('Il tuo valore sostituisce quello della ricetta (307.200).')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Argomenti extra'), { target: { value: '--rope-scale 4' } });
    fireEvent.change(screen.getByLabelText('Variabili d’ambiente'), { target: { value: 'GGML_X=2' } });
    expect(within(box).getByText('--rope-scale 7.5').className).toContain('line-through');
    expect(within(box).getByText('GGML_X=1').className).toContain('line-through');
    expect(within(box).getByText('--jinja').className).not.toContain('line-through');
    // Typing the recipe's own value is no replacement.
    await userEvent.clear(ctx);
    await userEvent.type(ctx, '307200');
    expect(screen.getAllByText('Dalla ricetta «Qwen YaRN»').length).toBeGreaterThan(0);
  });

  it('a recipe with only RoPE scaling, or nothing for llama.cpp: no context marker, no box', async () => {
    const api = benchApi({ local: [QWEN] }, { onboardingDone: true, expertMode: true, modelRecipes: [recipe({ contextSize: undefined, args: { vllm: ['--x'] }, env: {} })] });
    renderApp('/', api);
    expect(await screen.findByText('Dalla ricetta «Qwen YaRN»: YaRN ×7,50')).toBeTruthy();
    expect(((await screen.findByLabelText('Contesto (token)')) as HTMLInputElement).placeholder).toBe('Automatico');
    expect(screen.queryByText('Prima dei tuoi argomenti', { exact: false })).toBeNull();
  });

  it('vLLM: the recipe’s context is max-model-len; only its variables', async () => {
    const st = localModel('st', { format: 'safetensors', repo: 'Qwen/Qwen3-8B-FP8', file: undefined, facts: { contextLength: 40_960 } });
    const api = benchApi({ local: [st] }, { onboardingDone: true, expertMode: true, lastEngine: { kind: 'vllm-docker' }, modelRecipes: [recipe({ match: { name: 'qwen3-8b-fp8' }, args: {}, ropeScaling: undefined })] });
    renderApp('/', api);
    const max = (await screen.findByLabelText('Contesto massimo (token)')) as HTMLInputElement;
    await waitFor(() => expect(max.placeholder).toBe('307.200 dalla ricetta'));
    const box = screen.getByLabelText('Dalla ricetta «Qwen YaRN»');
    expect(within(box).queryByText('Prima dei tuoi argomenti', { exact: false })).toBeNull();
    expect(within(box).getByText('GGML_X=1')).toBeTruthy();
  });
});

describe('Contesto oltre il limite del modello (YaRN)', () => {
  const group = () => screen.getByRole('radiogroup', { name: 'Contesto oltre il limite del modello (YaRN)' });

  it('300K, 500K or another context: RoPE scaling at target / trained context, the context set, the warning', async () => {
    const api = benchApi({ local: [QWEN] }, { onboardingDone: true, expertMode: true });
    renderApp('/', api);
    await screen.findByLabelText('Contesto (token)');
    expect(within(group()).getByRole('radio', { name: 'No' }).getAttribute('aria-checked')).toBe('true');
    await userEvent.click(within(group()).getByRole('radio', { name: '300K' }));
    expect(screen.getByText('×7,50 rispetto ai 40.960 token di addestramento')).toBeTruthy();
    expect(screen.getByText('Oltre i 40K token la qualità non è garantita')).toBeTruthy();
    const ctx = screen.getByLabelText('Contesto (token)') as HTMLInputElement;
    expect(ctx.disabled).toBe(true);
    expect(ctx.placeholder).toBe('307.200 · YaRN');
    await waitFor(() => expect(lastPlan(api).params).toMatchObject({ contextSize: 307_200, maxModelLen: 307_200, ropeScaling: { type: 'yarn', factor: 7.5, originalContext: 40_960 } }));
    await userEvent.click(within(group()).getByRole('radio', { name: 'Altro' }));
    const custom = screen.getByLabelText('Contesto con YaRN (token)');
    await userEvent.clear(custom);
    await userEvent.type(custom, '20000');
    // Like any value that is not valid in expert mode: said, and ignored until it is fixed.
    expect(screen.getByText('Il modello legge già 40.960 token: scegli un contesto più grande.')).toBeTruthy();
    await userEvent.clear(custom);
    await userEvent.type(custom, '409600');
    await waitFor(() => expect(lastPlan(api).params?.ropeScaling?.factor).toBe(10));
    await userEvent.click(within(group()).getByRole('radio', { name: 'No' }));
    // Back to the plain launch (the plan it already had: nothing new is asked).
    await waitFor(() => expect((screen.getByLabelText('Contesto (token)') as HTMLInputElement).disabled).toBe(false));
    expect(screen.queryByText('Oltre i 40K token la qualità non è garantita')).toBeNull();
  });

  it('a model whose trained context is unknown cannot be extended; a remembered YaRN launch comes back as it was', async () => {
    const unknown = benchApi({}, { onboardingDone: true, expertMode: true });
    renderApp('/', unknown);
    await screen.findByLabelText('Contesto (token)');
    expect(screen.getByText('Serve sapere su quanto testo è stato addestrato il modello: scaricalo prima.')).toBeTruthy();
    expect(within(group()).getByRole('radio', { name: '300K' }).hasAttribute('disabled')).toBe(true);
    const api = benchApi({}, { onboardingDone: true, expertMode: true, lastParams: { contextSize: 512_000, ropeScaling: { type: 'yarn', factor: 16, originalContext: 32_000 }, extraArgs: [], env: {} } });
    renderApp('/', api);
    await waitFor(() => expect(screen.getAllByRole('radio', { name: '500K' }).some((r) => r.getAttribute('aria-checked') === 'true')).toBe(true));
    await waitFor(() => expect(lastPlan(api).params).toMatchObject({ contextSize: 512_000, ropeScaling: { factor: 16, originalContext: 32_000 } }));
    // Another context: "Altro" with it.
    cleanup();
    renderApp('/', benchApi({}, { onboardingDone: true, expertMode: true, lastParams: { contextSize: 409_600, ropeScaling: { type: 'yarn', factor: 12.8, originalContext: 32_000 }, extraArgs: [], env: {} } }));
    await waitFor(() => expect(within(group()).getByRole('radio', { name: 'Altro' }).getAttribute('aria-checked')).toBe('true'));
    expect((screen.getByLabelText('Contesto con YaRN (token)') as HTMLInputElement).value).toBe('409600');
  });

  it('"Trova le impostazioni migliori" (experts): the search goes on with YaRN up to the chosen context', async () => {
    const api = benchApi({ local: [QWEN] }, { onboardingDone: true, expertMode: true });
    renderApp('/', api);
    await userEvent.click(await screen.findByRole('radio', { name: /Trova le impostazioni migliori/ }));
    const yarn = await screen.findByRole('switch', { name: 'Cerca anche oltre il limite del modello (YaRN)' });
    expect(screen.getByText('Oltre i 40.960 token di addestramento la ricerca usa YaRN e prova fino al contesto scelto. Ci mette di più; la qualità lassù non è garantita.')).toBeTruthy();
    await userEvent.click(yarn);
    await waitFor(() => expect(lastPlan(api).tune?.yarnTarget).toBe(307_200));
    // The search's own choice comes first (the duration card), the launch's one is in the expert panel below.
    const tuneGroup = () => screen.getAllByRole('radiogroup', { name: 'Contesto oltre il limite del modello (YaRN)' })[0]!;
    await userEvent.click(within(tuneGroup()).getByRole('radio', { name: '500K' }));
    await waitFor(() => expect(lastPlan(api).tune?.yarnTarget).toBe(512_000));
    await userEvent.click(within(tuneGroup()).getByRole('radio', { name: 'Altro' }));
    const custom = screen.getAllByLabelText('Contesto con YaRN (token)')[0]!;
    await userEvent.clear(custom);
    await userEvent.type(custom, 'x');
    await userEvent.clear(custom);
    await userEvent.type(custom, '655360');
    await waitFor(() => expect(lastPlan(api).tune?.yarnTarget).toBe(655_360));
    await userEvent.click(yarn);
    await waitFor(() => expect(lastPlan(api).tune).not.toHaveProperty('yarnTarget'));
    // Several users: not offered.
    await userEvent.click(screen.getByRole('radio', { name: 'Più utenti' }));
    expect(screen.queryByRole('switch', { name: 'Cerca anche oltre il limite del modello (YaRN)' })).toBeNull();
  });

  it('the search cannot be extended for a model whose trained context is unknown', async () => {
    const api = benchApi({}, { onboardingDone: true, expertMode: true });
    renderApp('/', api);
    await userEvent.click(await screen.findByRole('radio', { name: /Trova le impostazioni migliori/ }));
    expect(((await screen.findByRole('switch', { name: 'Cerca anche oltre il limite del modello (YaRN)' })) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('Serve sapere il contesto di addestramento del modello.')).toBeTruthy();
  });
});

describe('plans and results say what the commands did', () => {
  it('the plan’s notes: beyond the trained context, a fork to set up, a missing file', async () => {
    const api = benchApi(
      {
        plan: () =>
          planFor({
            warnings: [
              { code: 'context_beyond_trained', params: { contextSize: 307_200, trained: 40_960, factor: 7.5, rope: 'yarn' } },
              { code: 'recipe_engine_missing', params: { template: 'prismml-bonsai', recipe: 'Bonsai' } },
              { code: 'recipe_file_missing', params: { part: 'draft', recipe: 'Bonsai' } },
              { code: 'recipe_file_missing', params: { part: 'mmproj', recipe: 'Bonsai' } },
            ],
          }),
      },
      { onboardingDone: true },
    );
    renderApp('/', api);
    expect(await screen.findByText('Oltre il contesto di addestramento')).toBeTruthy();
    expect(screen.getByText('Il modello è stato addestrato su 40.960 token e qui ne legge fino a 307.200: la qualità delle risposte non è garantita. Il test misura solo velocità e memoria.')).toBeTruthy();
    expect(screen.getByText('Manca il motore dei comandi di questo modello')).toBeTruthy();
    expect(screen.getByText('Manca il file MTP o draft')).toBeTruthy();
    expect(screen.getByText('Manca il proiettore immagini')).toBeTruthy();
  });

  it('"Come è stato avviato" names the commands the run used and the RoPE scaling of its configuration', async () => {
    const api = benchApi();
    const run = api.world.runs.find((r) => r.id === '01K6Y7Q2ZC4M8N3B5V9R1T0XWE')!;
    run.recipe = { id: 'q', name: 'Qwen YaRN', from: ['yarn'], parts: ['context', 'rope', 'args'], args: ['--jinja'], envNames: [], contextSize: 307_200, ropeScaling: { type: 'yarn', factor: 7.5, originalContext: 40_960 }, overridden: ['--jinja'], skipped: [] };
    run.launch.params = { ...run.launch.params, ropeScaling: { type: 'yarn', factor: 7.5, originalContext: 40_960 } };
    renderApp(`/results/${run.id}`, api);
    await userEvent.click(await screen.findByRole('tab', { name: 'Come è stato avviato' }));
    expect(await screen.findByText('Comandi del modello')).toBeTruthy();
    expect(screen.getByText('Usa i comandi «Qwen YaRN»: YaRN 300K · argomenti')).toBeTruthy();
    expect(screen.getByText('Sostituiti dai tuoi valori: --jinja')).toBeTruthy();
    expect(screen.getAllByText(/YaRN ×7,50 \(da 40\.960\)/).length).toBeGreaterThan(0);
  });
});
