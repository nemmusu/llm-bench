/**
 * "Comandi per questo modello" from the Models page: the section of a library model (in its dialog) and of
 * a Hugging Face repo (the model page's slot), the ready recipes, the editor and its live command.
 */
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerPlan, StartServerRequest } from '../../../../src/contract/api';
import { customEngineSchema } from '../../../../src/contract/custom-engines';
import { modelRecipeSchema, type ModelRecipe } from '../../../../src/contract/recipes';
import type { Settings } from '../../../../src/contract/settings';
import { bridge, fail, hubModel, libApi, localModel, patchPointer, renderLib, world, type LibApi } from '../library/fake';

vi.mock('echarts/core', () => ({ use: vi.fn(), init: vi.fn(() => ({ setOption: vi.fn(), resize: vi.fn(), dispose: vi.fn() })) }));
vi.mock('echarts/charts', () => ({ LineChart: {}, BarChart: {} }));
vi.mock('echarts/components', () => ({ AxisPointerComponent: {}, DataZoomComponent: {}, GridComponent: {}, LegendComponent: {}, MarkAreaComponent: {}, MarkLineComponent: {}, TooltipComponent: {} }));
vi.mock('echarts/renderers', () => ({ CanvasRenderer: {} }));

beforeEach(() => patchPointer());
afterEach(() => {
  delete (window as { gpubench?: unknown }).gpubench;
  vi.restoreAllMocks();
});

const M1 = localModel('m1', { identity: { facts: { paramsB: 8.2, contextLength: 40_960 } } });
const recipe = (over: Record<string, unknown> = {}): ModelRecipe =>
  modelRecipeSchema.parse({ id: 'm1-yarn', name: 'M1 YaRN', match: { models: [{ label: 'Model m1', weakKey: M1.identity.weakKey }] }, contextSize: 307_200, ropeScaling: { type: 'yarn', factor: 7.5, originalContext: 40_960 }, args: { llamacpp: ['--jinja'] }, ...over });

/** The fake's servers/plan echoes the recipe it was asked for into the command, so the preview is checkable. */
function withPlans(api: LibApi): StartServerRequest[] {
  const seen: StartServerRequest[] = [];
  api.on('POST /api/servers/plan', (b) => {
    const req = b as StartServerRequest;
    seen.push(req);
    const inline = req.recipe?.inline;
    const words = [`llama-server --engine ${req.engine.kind}`, ...(inline?.contextSize ? ['-c', String(inline.contextSize)] : []), ...(inline?.args.llamacpp ?? []), ...(req.recipe?.id ? [`--recipe ${req.recipe.id}`] : [])].join(' ');
    return { command: { argv: words.split(' '), powershell: words, bash: words }, needs: [], params: { extraArgs: [], env: {} }, warnings: [] } satisfies ServerPlan;
  });
  return seen;
}

async function openCommands(name = 'Model m1') {
  await userEvent.click(await screen.findByRole('button', { name: `Comandi per ${name}` }));
  return screen.findByRole('dialog', { name: new RegExp(`^Comandi per questo modello · ${name}`) });
}

const saved = (api: LibApi): ModelRecipe[] => api.w.settings.modelRecipes;

describe('a library model’s commands', () => {
  it('none yet: a ready recipe (YaRN 500K) through the editor, saved, then shown with its command and its badge', async () => {
    bridge();
    const api = libApi(world({ local: [M1] }));
    const plans = withPlans(api);
    renderLib('/models', api);
    const dialog = await openCommands();
    expect(within(dialog).getByText('Nessun comando particolare: il modello parte con le impostazioni normali.')).toBeTruthy();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Scegli da una ricetta pronta' }));
    const library = await screen.findByRole('dialog', { name: 'Ricette pronte' });
    // What fits this model first; what does not says why.
    const cards = within(library).getAllByRole('listitem');
    expect(within(cards[0]!).getByRole('heading', { name: 'Contesto esteso con YaRN' })).toBeTruthy();
    expect(within(library).getByText('Accanto al modello non c’è un file MTP o draft: scaricalo dalla pagina del modello.')).toBeTruthy();
    expect(within(library).getByText('Solo per i modelli Bonsai di PrismML.')).toBeTruthy();
    expect(within(library).getByText('Accanto al modello non c’è un proiettore immagini (mmproj).')).toBeTruthy();
    expect(within(library).getByText('Non serve per questo tipo di modello.')).toBeTruthy();
    expect(within(library).getByText('×7,50 rispetto ai 40.960 di addestramento')).toBeTruthy();
    await userEvent.click(within(library).getByRole('radio', { name: '500K' }));
    expect(within(library).getByText('×12,50 rispetto ai 40.960 di addestramento')).toBeTruthy();
    await userEvent.click(within(library).getAllByRole('button', { name: 'Documentazione' })[0]!);
    expect(window.gpubench?.openExternal).toHaveBeenCalledWith('https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md');
    await userEvent.click(within(library).getByRole('button', { name: 'Usa: Contesto esteso con YaRN' }));
    const editor = await screen.findByRole('dialog', { name: 'Scrivi i comandi per Model m1' });
    expect(within(editor).getByRole('radio', { name: 'Oltre il limite (YaRN)' }).getAttribute('aria-checked')).toBe('true');
    expect(within(editor).getByRole('radio', { name: '500K' }).getAttribute('aria-checked')).toBe('true');
    expect(within(editor).getByText('Oltre i 40K token la qualità non è garantita')).toBeTruthy();
    // The live command: the core's plan of this unsaved recipe.
    await waitFor(() => expect(within(editor).getByRole('region', { name: 'Comando completo' }).textContent).toContain('-c 512000'), { timeout: 3000 });
    expect(plans.at(-1)).toMatchObject({ engine: { kind: 'llamacpp-native' }, model: { localId: 'm1' }, recipe: { use: true, inline: { contextSize: 512_000, from: ['yarn'] } } });
    await userEvent.click(within(editor).getByRole('button', { name: 'Salva' }));
    await waitFor(() => expect(saved(api)).toHaveLength(1));
    expect(saved(api)[0]).toMatchObject({ id: 'model-m1', name: 'Model m1', contextSize: 512_000, ropeScaling: { type: 'yarn', factor: 12.5, originalContext: 40_960 }, match: { models: [{ weakKey: M1.identity.weakKey }] }, from: ['yarn'] });
    expect(await screen.findByText('Comandi salvati')).toBeTruthy();
    expect(within(dialog).getByText('Ricetta «Model m1»')).toBeTruthy();
    expect(within(dialog).getByText('Solo per questo modello')).toBeTruthy();
    expect(within(dialog).getByText('YaRN 500K')).toBeTruthy();
    await waitFor(() => expect(within(dialog).getByRole('region', { name: 'Comando completo' }).textContent).toContain('--recipe model-m1'), { timeout: 3000 });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Chiudi' }));
    expect(await screen.findByText('Comandi: Model m1')).toBeTruthy();
  });

  it('edit, change, then remove; a recipe left empty is removed when saved', async () => {
    bridge();
    const api = libApi(world({ local: [M1], settings: { ...world().settings, modelRecipes: [recipe({ notes: 'Dalla scheda', link: 'https://huggingface.co/x' })] } }));
    withPlans(api);
    renderLib('/models', api);
    const dialog = await openCommands();
    expect(within(dialog).getByText('Dalla scheda')).toBeTruthy();
    await userEvent.click(within(dialog).getByRole('button', { name: 'https://huggingface.co/x' }));
    expect(window.gpubench?.openExternal).toHaveBeenCalledWith('https://huggingface.co/x');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Modifica' }));
    let editor = await screen.findByRole('dialog', { name: 'Modifica i comandi' });
    await userEvent.click(within(editor).getByRole('radio', { name: 'Un valore preciso' }));
    const ctx = within(editor).getByLabelText('Contesto (token)');
    await userEvent.type(ctx, '65536');
    await userEvent.click(within(editor).getByRole('button', { name: 'Salva' }));
    await waitFor(() => expect(saved(api)[0]).toMatchObject({ id: 'm1-yarn', contextSize: 65_536 }));
    expect(saved(api)[0]?.ropeScaling).toBeUndefined();
    // Nothing left: saving removes it.
    await userEvent.click(within(dialog).getByRole('button', { name: 'Modifica' }));
    editor = await screen.findByRole('dialog', { name: 'Modifica i comandi' });
    await userEvent.click(within(editor).getByRole('radio', { name: 'Automatico' }));
    await userEvent.clear(within(editor).getByLabelText('Argomenti in più · llama.cpp'));
    await userEvent.click(within(editor).getByRole('button', { name: 'Salva' }));
    await waitFor(() => expect(saved(api)).toEqual([]));
    expect(await screen.findByText('Comandi rimossi')).toBeTruthy();
    expect(within(dialog).getByText('Nessun comando particolare: il modello parte con le impostazioni normali.')).toBeTruthy();
  });

  it('"Rimuovi i comandi" removes it; a new empty recipe is not saved', async () => {
    const api = libApi(world({ local: [M1], settings: { ...world().settings, modelRecipes: [recipe()] } }));
    withPlans(api);
    renderLib('/models', api);
    const dialog = await openCommands();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Modifica' }));
    const editor = await screen.findByRole('dialog', { name: 'Modifica i comandi' });
    await userEvent.click(within(editor).getByRole('button', { name: 'Rimuovi i comandi' }));
    await waitFor(() => expect(saved(api)).toEqual([]));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Scrivi i comandi' }));
    const fresh = await screen.findByRole('dialog', { name: 'Scrivi i comandi per Model m1' });
    await userEvent.click(within(fresh).getByRole('button', { name: 'Salva' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Scrivi i comandi per Model m1' })).toBeNull());
    expect(saved(api)).toEqual([]);
  });

  it('writing commands by hand: every field, its checks, the engines and the other engines’ arguments', async () => {
    bridge();
    const fork = customEngineSchema.parse({ id: 'my-fork', name: 'Il mio fork', base: 'llamacpp', run: { mode: 'native', path: '/f' } });
    const api = libApi(world({ local: [M1], settings: { ...world().settings, customEngines: [fork] } }));
    withPlans(api);
    renderLib('/models', api);
    const dialog = await openCommands();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Scrivi i comandi' }));
    const editor = await screen.findByRole('dialog', { name: 'Scrivi i comandi per Model m1' });
    const name = within(editor).getByLabelText('Nome');
    await userEvent.clear(name);
    await userEvent.click(within(editor).getByRole('radio', { name: 'Tutti i modelli di una famiglia' }));
    await userEvent.type(within(editor).getByLabelText('Il nome contiene'), '/(/');
    await userEvent.click(within(editor).getByRole('radio', { name: 'Un valore preciso' }));
    await userEvent.type(within(editor).getByLabelText('Contesto (token)'), '12');
    await userEvent.click(within(editor).getByRole('radio', { name: 'Un file che scelgo io' }));
    await userEvent.type(within(editor).getByLabelText('Argomenti in più · llama.cpp'), '--chat-template "open');
    await userEvent.type(within(editor).getByLabelText('Variabili d’ambiente'), 'not a variable');
    await userEvent.type(within(editor).getByLabelText('Pagina del modello'), 'nope');
    await userEvent.click(within(editor).getByRole('button', { name: 'Salva' }));
    expect(within(editor).getByText('Controlla i campi segnati in rosso.')).toBeTruthy();
    expect(within(editor).getByText('Una virgoletta non è chiusa.')).toBeTruthy();
    expect(within(editor).getByText('Usa una riga per variabile, nel formato NOME=valore.')).toBeTruthy();
    expect(within(editor).getByText('Scrivi un indirizzo completo, che inizia con https://')).toBeTruthy();
    expect(saved(api)).toEqual([]);
    // Fix everything.
    await userEvent.type(name, 'Famiglia M');
    await userEvent.clear(within(editor).getByLabelText('Il nome contiene'));
    await userEvent.type(within(editor).getByLabelText('Il nome contiene'), 'model m');
    await userEvent.type(within(editor).getByLabelText('Solo questa quantizzazione'), 'Q4_K_M');
    await userEvent.clear(within(editor).getByLabelText('Contesto (token)'));
    await userEvent.type(within(editor).getByLabelText('Contesto (token)'), '65536');
    await userEvent.click(within(editor).getByRole('button', { name: 'Sfoglia…' }));
    await waitFor(() => expect((within(editor).getByLabelText('File del modello draft o MTP (.gguf)') as HTMLInputElement).value).toBe('D:\\llama\\llama-server.exe'));
    await userEvent.click(within(editor).getByRole('switch', { name: 'Carica il proiettore immagini (llama.cpp)' }));
    expect(within(editor).getByText('Accanto al modello non c’è un file mmproj.')).toBeTruthy();
    const args = within(editor).getByLabelText('Argomenti in più · llama.cpp');
    await userEvent.clear(args);
    fireEvent.change(args, { target: { value: '--chat-template "a b"' } });
    await userEvent.click(within(editor).getByRole('radio', { name: /^vLLM/ }));
    fireEvent.change(within(editor).getByLabelText('Argomenti in più · vLLM'), { target: { value: '--enforce-eager' } });
    const env = within(editor).getByLabelText('Variabili d’ambiente');
    await userEvent.clear(env);
    await userEvent.type(env, 'GGML_X=1');
    await userEvent.clear(within(editor).getByLabelText('Pagina del modello'));
    await userEvent.type(within(editor).getByLabelText('Pagina del modello'), 'https://huggingface.co/m');
    await userEvent.type(within(editor).getByLabelText('Note'), 'Prova');
    // Engines: GPU Bench's own and the saved custom ones.
    const engine = within(editor).getByRole('combobox', { name: 'Motore' });
    engine.focus();
    fireEvent.keyDown(engine, { key: 'Enter' });
    fireEvent.click(await screen.findByRole('option', { name: 'Il mio fork' }));
    await userEvent.click(within(editor).getByRole('button', { name: 'Salva' }));
    await waitFor(() => expect(saved(api)).toHaveLength(1));
    expect(saved(api)[0]).toMatchObject({
      id: 'famiglia-m',
      match: { models: [], name: 'model m', quant: 'Q4_K_M' },
      contextSize: 65_536,
      draft: 'D:\\llama\\llama-server.exe',
      mmproj: true,
      engine: { type: 'custom', id: 'my-fork' },
      args: { llamacpp: ['--chat-template', 'a b'], vllm: ['--enforce-eager'] },
      env: { GGML_X: '1' },
      notes: 'Prova',
      link: 'https://huggingface.co/m',
    });
    expect(within(dialog).getByText('Per i modelli «model m» in Q4_K_M')).toBeTruthy();
    expect(within(dialog).getByText('llama.cpp · Il mio fork')).toBeTruthy();
  });

  it('the MTP file and the projector next to the model; a draft file chosen by hand without the desktop bridge', async () => {
    const withAux = localModel('m2', { identity: { facts: { contextLength: 32_768 } }, auxiliary: [{ kind: 'mtp', path: 'C:\\Models\\mtp-m2.gguf' }, { kind: 'mmproj', path: 'C:\\Models\\mmproj.gguf' }] });
    const api = libApi(world({ local: [withAux] }));
    withPlans(api);
    renderLib('/models', api);
    const dialog = await openCommands('Model m2');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Scegli da una ricetta pronta' }));
    const library = await screen.findByRole('dialog', { name: 'Ricette pronte' });
    await userEvent.click(within(library).getByRole('button', { name: 'Usa: Decodifica speculativa con MTP / modello draft' }));
    const editor = await screen.findByRole('dialog', { name: 'Scrivi i comandi per Model m2' });
    expect(within(editor).getByRole('radio', { name: 'Il file MTP o draft accanto al modello' }).getAttribute('aria-checked')).toBe('true');
    expect(within(editor).getByText('Trovato: mtp-m2.gguf')).toBeTruthy();
    expect(within(editor).getByText('Serve per mandare immagini al server. Occupa un po’ di memoria video in più, anche nei test.')).toBeTruthy();
    // No desktop bridge: no "Sfoglia…"; the path is typed.
    await userEvent.click(within(editor).getByRole('radio', { name: 'Un file che scelgo io' }));
    expect(within(editor).queryByRole('button', { name: 'Sfoglia…' })).toBeNull();
    await userEvent.type(within(editor).getByLabelText('File del modello draft o MTP (.gguf)'), 'C:\\d.gguf');
    expect((within(editor).getByLabelText('File del modello draft o MTP (.gguf)') as HTMLInputElement).value).toBe('C:\\d.gguf');
    await userEvent.click(within(editor).getByRole('radio', { name: 'Il file MTP o draft accanto al modello' }));
    await userEvent.click(within(editor).getByRole('button', { name: 'Salva' }));
    await waitFor(() => expect(saved(api)).toHaveLength(1));
    expect(saved(api)[0]).toMatchObject({ draft: 'auto', args: { vllm: ['--speculative-config', '{"method":"mtp","num_speculative_tokens":1}'] }, from: ['mtp'] });
    // A second ready recipe goes into the same recipe.
    await userEvent.click(within(dialog).getByRole('button', { name: 'Scegli da una ricetta pronta' }));
    const again = await screen.findByRole('dialog', { name: 'Ricette pronte' });
    await userEvent.click(within(again).getByRole('button', { name: 'Usa: Modelli con immagini (proiettore mmproj)' }));
    const edit = await screen.findByRole('dialog', { name: 'Modifica i comandi' });
    await userEvent.click(within(edit).getByRole('button', { name: 'Salva' }));
    await waitFor(() => expect(saved(api)[0]).toMatchObject({ draft: 'auto', mmproj: true, from: ['mtp', 'vision'] }));
    expect(saved(api)).toHaveLength(1);
  });

  it('YaRN for a model whose trained context is unknown: the user says it', async () => {
    const api = libApi(world({ local: [localModel('m3')] }));
    withPlans(api);
    renderLib('/models', api);
    const dialog = await openCommands('Model m3');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Scrivi i comandi' }));
    const editor = await screen.findByRole('dialog', { name: 'Scrivi i comandi per Model m3' });
    await userEvent.click(within(editor).getByRole('radio', { name: 'Oltre il limite (YaRN)' }));
    expect(within(editor).getByText('Serve sapere su quanto testo è stato addestrato il modello: scaricalo prima.')).toBeTruthy();
    await userEvent.click(within(editor).getByRole('button', { name: 'Salva' }));
    expect(saved(api)).toEqual([]);
    await userEvent.type(within(editor).getByLabelText('Contesto di addestramento (token)'), '32768');
    expect(within(editor).getByText('×9,38 rispetto ai 32.768 token di addestramento')).toBeTruthy();
    await userEvent.click(within(editor).getByRole('radio', { name: 'Altro' }));
    const custom = within(editor).getByLabelText('Contesto con YaRN (token)');
    expect((custom as HTMLInputElement).value).toBe('1048576');
    await userEvent.clear(custom);
    await userEvent.type(custom, '16384');
    expect(within(editor).getByText('Il modello legge già 32.768 token: scegli un contesto più grande.')).toBeTruthy();
    await userEvent.clear(custom);
    await userEvent.type(custom, '131072');
    await userEvent.click(within(editor).getByRole('button', { name: 'Salva' }));
    await waitFor(() => expect(saved(api)[0]).toMatchObject({ contextSize: 131_072, ropeScaling: { type: 'yarn', factor: 4, originalContext: 32_768 } }));
  });

  it('the preview says when the core cannot make one, and offers each engine of a safetensors model', async () => {
    const st = localModel('st', { identity: { format: 'safetensors', displayName: 'Qwen3-8B-FP8', repo: 'Qwen/Qwen3-8B-FP8', file: undefined, quant: undefined } });
    const api = libApi(world({ local: [st], settings: { ...world().settings, modelRecipes: [modelRecipeSchema.parse({ id: 'st', name: 'ST', match: { models: [{ label: 'x', weakKey: st.identity.weakKey }] }, args: { vllm: ['--enforce-eager'] } })] } }));
    const kinds: string[] = [];
    api.on('POST /api/servers/plan', (b) => {
      kinds.push((b as StartServerRequest).engine.kind);
      return fail('DOCKER_NOT_RUNNING');
    });
    renderLib('/models', api);
    const dialog = await openCommands('Qwen3-8B-FP8');
    expect(await within(dialog).findByText('Anteprima non disponibile: Docker non è avviato')).toBeTruthy();
    await userEvent.click(within(dialog).getByRole('radio', { name: 'SGLang (Docker)' }));
    await waitFor(() => expect(kinds).toContain('sglang-docker'));
  });
});

describe('the PrismML fork for Bonsai models', () => {
  const bonsai = localModel('bonsai', { identity: { displayName: 'Ternary-Bonsai-8B-PQ2_0', file: 'Ternary-Bonsai-8B-PQ2_0.gguf', quant: 'PQ2_0', weakKey: 'local/bonsai' } });

  it('no fork set up: the card and the saved recipe lead to the Engines page, filled in for this model', async () => {
    const api = libApi(world({ local: [bonsai] }));
    withPlans(api);
    const { router } = renderLib('/models', api);
    let dialog = await openCommands('Ternary-Bonsai-8B-PQ2_0');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Scegli da una ricetta pronta' }));
    const library = await screen.findByRole('dialog', { name: 'Ricette pronte' });
    expect(within(library).getByText('Non hai ancora indicato dove si trova il fork sul tuo PC.')).toBeTruthy();
    await userEvent.click(within(library).getByRole('button', { name: 'Usa: Fork PrismML per modelli Bonsai' }));
    const editor = await screen.findByRole('dialog', { name: 'Scrivi i comandi per Ternary-Bonsai-8B-PQ2_0' });
    expect(within(editor).getByRole('combobox', { name: 'Motore' }).textContent).toContain('Fork PrismML (da indicare in Motori)');
    await userEvent.click(within(editor).getByRole('button', { name: 'Salva' }));
    await waitFor(() => expect(saved(api)[0]?.engine).toEqual({ type: 'template', template: 'prismml-bonsai' }));
    expect(within(dialog).getByText('Fork PrismML (da indicare)')).toBeTruthy();
    expect(within(dialog).getByText('Manca il motore di questi comandi')).toBeTruthy();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Indica dove si trova il fork' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/engines'));
    expect(router.state.location.search).toEqual({ customTemplate: 'prismml-bonsai', model: 'local/bonsai', modelName: 'Ternary-Bonsai-8B-PQ2_0' });
    // From the ready recipe's card too.
    await router.navigate({ to: '/models' });
    dialog = await openCommands('Ternary-Bonsai-8B-PQ2_0');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Scegli da una ricetta pronta' }));
    const again = await screen.findByRole('dialog', { name: 'Ricette pronte' });
    await userEvent.click(within(again).getByRole('button', { name: 'Indica dove si trova il fork' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/engines'));
  });

  it('a fork set up: the card says which one is used', async () => {
    const fork = customEngineSchema.parse({ id: 'prismml', name: 'Fork PrismML', base: 'llamacpp', run: { mode: 'native', path: '/p' }, template: 'prismml-bonsai' });
    const api = libApi(world({ local: [bonsai], settings: { ...world().settings, customEngines: [fork] } as Settings }));
    withPlans(api);
    renderLib('/models', api);
    const dialog = await openCommands('Ternary-Bonsai-8B-PQ2_0');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Scegli da una ricetta pronta' }));
    const library = await screen.findByRole('dialog', { name: 'Ricette pronte' });
    expect(within(library).getByText('Userà Fork PrismML.')).toBeTruthy();
    expect(within(library).queryByRole('button', { name: 'Indica dove si trova il fork' })).toBeNull();
  });
});

describe('a Hugging Face repo’s commands (the model page)', () => {
  it('for every file of the repo, with its trained context and its projector', async () => {
    const api = libApi(world({ search: [hubModel('org/Model-GGUF')] }));
    withPlans(api);
    renderLib('/models/hub/org/Model-GGUF', api);
    const section = (await screen.findByRole('heading', { name: 'Comandi per questo modello' })).closest('[data-section="recipes"]') as HTMLElement;
    expect(within(section).getByText('Nessun comando particolare: il modello parte con le impostazioni normali.')).toBeTruthy();
    await userEvent.click(within(section).getByRole('button', { name: 'Scegli da una ricetta pronta' }));
    const library = await screen.findByRole('dialog', { name: 'Ricette pronte' });
    expect(within(library).getByText('×2,34 rispetto ai 131.072 di addestramento')).toBeTruthy();
    await userEvent.click(within(library).getByRole('button', { name: 'Usa: Modelli con immagini (proiettore mmproj)' }));
    const editor = await screen.findByRole('dialog', { name: 'Scrivi i comandi per Model-GGUF' });
    await userEvent.click(within(editor).getByRole('button', { name: 'Salva' }));
    await waitFor(() => expect(saved(api)[0]).toMatchObject({ mmproj: true, match: { models: [{ label: 'Model-GGUF', repo: 'org/Model-GGUF' }] } }));
    expect(within(section).getByText('Immagini')).toBeTruthy();
  });

  it('a safetensors repo previews vLLM and SGLang; an NInfer artifact NInfer, its ready recipe choosing it', async () => {
    const st = libApi(world({ search: [hubModel('org/Model-FP8')], files: [{ path: 'config.json', sizeBytes: 10, kind: 'config' }, { path: 'model.safetensors', sizeBytes: 5e9, kind: 'weights' }] }));
    const kinds = withPlans(st);
    renderLib('/models/hub/org/Model-FP8', st);
    const section = (await screen.findByRole('heading', { name: 'Comandi per questo modello' })).closest('[data-section="recipes"]') as HTMLElement;
    await userEvent.click(within(section).getByRole('button', { name: 'Scrivi i comandi' }));
    const editor = await screen.findByRole('dialog', { name: 'Scrivi i comandi per Model-FP8' });
    // No llama.cpp files for vLLM: no draft or projector choice; the arguments start on vLLM.
    expect(within(editor).queryByText('Decodifica speculativa (llama.cpp)')).toBeNull();
    expect(within(editor).getByLabelText('Argomenti in più · vLLM')).toBeTruthy();
    await waitFor(() => expect(kinds.some((k) => k.engine.kind === 'vllm-docker')).toBe(true));
    cleanup();
    const nf = libApi(world({ search: [hubModel('org/Qwen3.8-27B-NInfer')], files: [{ path: 'qwen3_8_27b.ninfer', sizeBytes: 2e10, kind: 'weights' }] }));
    withPlans(nf);
    renderLib('/models/hub/org/Qwen3.8-27B-NInfer', nf);
    const s2 = (await screen.findByRole('heading', { name: 'Comandi per questo modello' })).closest('[data-section="recipes"]') as HTMLElement;
    await userEvent.click(within(s2).getByRole('button', { name: 'Scegli da una ricetta pronta' }));
    const library = await screen.findByRole('dialog', { name: 'Ricette pronte' });
    await userEvent.click(within(library).getByRole('button', { name: 'Usa: NInfer per i modelli .ninfer' }));
    const e2 = await screen.findByRole('dialog', { name: 'Scrivi i comandi per Qwen3.8-27B-NInfer' });
    expect(within(e2).getByLabelText('Argomenti in più · NInfer')).toBeTruthy();
    await userEvent.click(within(e2).getByRole('button', { name: 'Salva' }));
    await waitFor(() => expect(saved(nf)[0]?.engine).toEqual({ type: 'builtin', kind: 'ninfer-native' }));
    expect(within(s2).getByText('NInfer')).toBeTruthy();
  });

  it('a model trained past every offered target: YaRN proposes twice its context', async () => {
    const big = localModel('big', { identity: { facts: { contextLength: 1_048_576 } } });
    const api = libApi(world({ local: [big] }));
    withPlans(api);
    renderLib('/models', api);
    const dialog = await openCommands('Model big');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Scegli da una ricetta pronta' }));
    const library = await screen.findByRole('dialog', { name: 'Ricette pronte' });
    expect(within(library).getByRole('radio', { name: '2M' }).getAttribute('aria-checked')).toBe('true');
    expect(within(library).getByText('×2,00 rispetto ai 1.048.576 di addestramento')).toBeTruthy();
  });

  it('nothing for a repo without loadable weights', async () => {
    const api = libApi(world({ search: [hubModel('org/Docs')], files: [{ path: 'README.md', sizeBytes: 10, kind: 'other' }] }));
    renderLib('/models/hub/org/Docs', api);
    await screen.findByText('File del repository');
    expect(screen.queryByRole('heading', { name: 'Comandi per questo modello' })).toBeNull();
  });
});
