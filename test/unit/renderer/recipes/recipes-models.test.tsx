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
    return { command: { argv: words.split(' '), powershell: words, bash: words }, needs: [], params: { extraArgs: [], env: {} }, warnings: [], port: 8080, network: 'local' } satisfies ServerPlan;
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
    // NInfer and NInfer-all are for .ninfer models only.
    expect(within(library).getAllByText('Non serve per questo tipo di modello.')).toHaveLength(2);
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

  it('edit, change, then remove; saving a recipe left empty asks to delete it', async () => {
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
    // Nothing left: saving asks to delete it ("Annulla" keeps it), then deletes it.
    await userEvent.click(within(dialog).getByRole('button', { name: 'Modifica' }));
    editor = await screen.findByRole('dialog', { name: 'Modifica i comandi' });
    await userEvent.click(within(editor).getByRole('radio', { name: 'Automatico' }));
    await userEvent.clear(within(editor).getByLabelText('Argomenti in più · llama.cpp'));
    await userEvent.click(within(editor).getByRole('button', { name: 'Salva' }));
    let ask = await screen.findByRole('alertdialog', { name: 'Eliminare la ricetta «M1 YaRN»?' });
    expect(within(ask).getByText('Non c’è più niente dentro: il modello torna a partire con le impostazioni normali.')).toBeTruthy();
    await userEvent.click(within(ask).getByRole('button', { name: 'Annulla' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(saved(api)).toHaveLength(1);
    await userEvent.click(within(editor).getByRole('button', { name: 'Salva' }));
    ask = await screen.findByRole('alertdialog', { name: 'Eliminare la ricetta «M1 YaRN»?' });
    await userEvent.click(within(ask).getByRole('button', { name: 'Elimina' }));
    await waitFor(() => expect(saved(api)).toEqual([]));
    expect(await screen.findByText('Ricetta eliminata')).toBeTruthy();
    expect(within(dialog).getByText('Nessun comando particolare: il modello parte con le impostazioni normali.')).toBeTruthy();
  });

  it('"Elimina ricetta" deletes it after a confirmation; a new empty recipe says what to set', async () => {
    const api = libApi(world({ local: [M1], settings: { ...world().settings, modelRecipes: [recipe()] } }));
    withPlans(api);
    renderLib('/models', api);
    const dialog = await openCommands();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Modifica' }));
    const editor = await screen.findByRole('dialog', { name: 'Modifica i comandi' });
    await userEvent.click(within(editor).getByRole('button', { name: 'Elimina ricetta' }));
    const ask = await screen.findByRole('alertdialog', { name: 'Eliminare la ricetta «M1 YaRN»?' });
    expect(within(ask).getByText('Il modello torna a partire con le impostazioni normali.')).toBeTruthy();
    await userEvent.click(within(ask).getByRole('button', { name: 'Elimina' }));
    await waitFor(() => expect(saved(api)).toEqual([]));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Scrivi i comandi' }));
    const fresh = await screen.findByRole('dialog', { name: 'Scrivi i comandi per Model m1' });
    // A new recipe has nothing to delete.
    expect(within(fresh).queryByRole('button', { name: 'Elimina ricetta' })).toBeNull();
    await userEvent.click(within(fresh).getByRole('button', { name: 'Salva' }));
    expect(within(fresh).getByText('Ancora niente da salvare: imposta il contesto, il motore o un argomento.')).toBeTruthy();
    expect(saved(api)).toEqual([]);
    await userEvent.click(within(fresh).getByRole('button', { name: 'Annulla' }));
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
    // Engines: LLM Bench's own and the saved custom ones.
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

  it('a draft next to the model (not only MTP) or none, a cancelled picker, next to other recipes', async () => {
    const b = bridge({ pickFile: vi.fn(async () => null) });
    const other = recipe({ id: 'other', name: 'Other', match: { models: [{ label: 'Model zz', weakKey: 'local/zz' }] } });
    const withDraft = localModel('m4', { identity: { facts: { contextLength: 40_960 } }, auxiliary: [{ kind: 'mmproj', path: 'C:\\Models\\mmproj.gguf' }, { kind: 'draft', path: 'C:\\Models\\draft-m4.gguf' }] });
    const api = libApi(world({ local: [withDraft, localModel('m5')], settings: { ...world().settings, modelRecipes: [other] } }));
    withPlans(api);
    renderLib('/models', api);
    let dialog = await openCommands('Model m4');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Scrivi i comandi' }));
    let editor = await screen.findByRole('dialog', { name: 'Scrivi i comandi per Model m4' });
    // A draft model next to it counts like an MTP file.
    await userEvent.click(within(editor).getByRole('radio', { name: 'Il file MTP o draft accanto al modello' }));
    expect(within(editor).getByText('Trovato: draft-m4.gguf')).toBeTruthy();
    // "Sfoglia…" closed without a file: the field stays as it was.
    await userEvent.click(within(editor).getByRole('radio', { name: 'Un file che scelgo io' }));
    await userEvent.click(within(editor).getByRole('button', { name: 'Sfoglia…' }));
    expect(b.pickFile).toHaveBeenCalledTimes(1);
    expect((within(editor).getByLabelText('File del modello draft o MTP (.gguf)') as HTMLInputElement).value).toBe('');
    await userEvent.click(within(editor).getByRole('radio', { name: 'Il file MTP o draft accanto al modello' }));
    // YaRN on a model that says its training context: no field to ask it.
    await userEvent.click(within(editor).getByRole('radio', { name: 'Oltre il limite (YaRN)' }));
    expect(within(editor).queryByLabelText('Contesto di addestramento (token)')).toBeNull();
    await userEvent.click(within(editor).getByRole('radio', { name: 'Automatico' }));
    // Saved next to another model's recipe: its own id, first.
    await userEvent.click(within(editor).getByRole('button', { name: 'Salva' }));
    await waitFor(() => expect(saved(api)).toHaveLength(2));
    expect(saved(api)[0]).toMatchObject({ id: 'model-m4', draft: 'auto' });
    expect(saved(api)[1]).toEqual(other);
    // Changed later: the other recipe stays as it is.
    await userEvent.click(within(dialog).getByRole('button', { name: 'Modifica' }));
    editor = await screen.findByRole('dialog', { name: 'Modifica i comandi' });
    await userEvent.click(within(editor).getByRole('radio', { name: 'No' }));
    await userEvent.click(within(editor).getByRole('radio', { name: 'Un valore preciso' }));
    await userEvent.type(within(editor).getByLabelText('Contesto (token)'), '8192');
    await userEvent.click(within(editor).getByRole('button', { name: 'Salva' }));
    await waitFor(() => expect(saved(api)[0]).toMatchObject({ id: 'model-m4', contextSize: 8192 }));
    expect(saved(api)[1]).toEqual(other);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Chiudi' }));
    // Nothing next to this one: "the file next to the model" says it is missing.
    dialog = await openCommands('Model m5');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Scrivi i comandi' }));
    editor = await screen.findByRole('dialog', { name: 'Scrivi i comandi per Model m5' });
    await userEvent.click(within(editor).getByRole('radio', { name: 'Il file MTP o draft accanto al modello' }));
    expect(within(editor).getByText('Accanto al modello non c’è un file MTP o draft: scaricalo dalla pagina del modello.')).toBeTruthy();
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

describe('NInfer-all for GGUF-NInfer artifacts', () => {
  const gguf = localModel('gg', {
    identity: { displayName: 'Coder-Q6_K-MTP', format: 'ninfer', repo: 'nerkyor/Coder-GGUF-NInfer', file: 'Coder-Q6_K-MTP.ninfer', quant: 'Q6_K', weakKey: 'local/gg' },
  });

  it('its ready recipe: NInfer-all not added yet leads to the Engines page; once added, it says which one', async () => {
    const api = libApi(world({ local: [gguf] }));
    withPlans(api);
    const { router } = renderLib('/models', api);
    const dialog = await openCommands('Coder-Q6_K-MTP');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Scegli da una ricetta pronta' }));
    const library = await screen.findByRole('dialog', { name: 'Ricette pronte' });
    expect(within(library).getByRole('heading', { name: 'NInfer-all per i modelli GGUF-NInfer' })).toBeTruthy();
    expect(within(library).getByText('Non hai ancora aggiunto NInfer-all.')).toBeTruthy();
    // Used: the saved recipe says its engine is still to add.
    await userEvent.click(within(library).getByRole('button', { name: 'Usa: NInfer-all per i modelli GGUF-NInfer' }));
    const editor = await screen.findByRole('dialog', { name: 'Scrivi i comandi per Coder-Q6_K-MTP' });
    await userEvent.click(within(editor).getByRole('button', { name: 'Salva' }));
    await waitFor(() => expect(saved(api)[0]?.engine).toEqual({ type: 'template', template: 'ninfer-all' }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Aggiungi NInfer-all' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/engines'));
    expect(router.state.location.search).toMatchObject({ customTemplate: 'ninfer-all', model: 'local/gg' });
    await router.navigate({ to: '/models' });
    const fromCard = await openCommands('Coder-Q6_K-MTP');
    await userEvent.click(within(fromCard).getByRole('button', { name: 'Scegli da una ricetta pronta' }));
    await userEvent.click(within(await screen.findByRole('dialog', { name: 'Ricette pronte' })).getByRole('button', { name: 'Aggiungi NInfer-all' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/engines'));
    cleanup();
    const all = customEngineSchema.parse({ id: 'ninfer-all', name: 'NInfer-all', base: 'ninfer', template: 'ninfer-all', run: { mode: 'ninfer', path: '/home/u/ninfer-all', distro: 'Ubuntu-24.04' } });
    const withAll = libApi(world({ local: [gguf], settings: { ...world().settings, customEngines: [all] } as Settings }));
    withPlans(withAll);
    renderLib('/models', withAll);
    const again = await openCommands('Coder-Q6_K-MTP');
    await userEvent.click(within(again).getByRole('button', { name: 'Scegli da una ricetta pronta' }));
    expect(within(await screen.findByRole('dialog', { name: 'Ricette pronte' })).getByText('Userà NInfer-all.')).toBeTruthy();
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

describe('the editor offers what can run the model, and the common arguments a click away', () => {
  const engineOptions = async (editor: HTMLElement): Promise<string[]> => {
    const engine = within(editor).getByRole('combobox', { name: 'Motore' });
    engine.focus();
    fireEvent.keyDown(engine, { key: 'Enter' });
    const names = (await screen.findAllByRole('option')).map((o) => o.textContent ?? '');
    fireEvent.keyDown(await screen.findByRole('listbox'), { key: 'Escape' });
    return names;
  };
  const fork = customEngineSchema.parse({ id: 'my-fork', name: 'Il mio fork', base: 'llamacpp', run: { mode: 'native', path: '/f' } });
  const variant = customEngineSchema.parse({ id: 'nf-var', name: 'NInfer variante', base: 'ninfer', run: { mode: 'ninfer', path: '/home/u/nf' } });
  const vfork = customEngineSchema.parse({ id: 'v-fork', name: 'Fork vLLM', base: 'vllm', run: { mode: 'native', path: '/v' } });
  const program = customEngineSchema.parse({ id: 'prog', name: 'Il mio programma', base: 'openai-server', run: { mode: 'command', template: 'srv --model {model} --port {port}' } });

  it('a .ninfer model: NInfer only, no YaRN, its own one-click arguments', async () => {
    const nf = localModel('nf', { identity: { displayName: 'Qwen3.8-27B-NInfer', format: 'ninfer', file: 'q.ninfer', quant: undefined, weakKey: 'local/nf' } });
    const nfYarn = localModel('nf2', { identity: { displayName: 'Qwen3.6-27B-NInfer', format: 'ninfer', file: 'q2.ninfer', quant: undefined, weakKey: 'local/nf2', facts: { contextLength: 262_144 } } });
    const old = modelRecipeSchema.parse({ id: 'nf2', name: 'NF2', match: { models: [{ label: 'x', weakKey: 'local/nf2' }] }, contextSize: 524_288, ropeScaling: { type: 'yarn', factor: 2, originalContext: 262_144 } });
    const api = libApi(world({ local: [nf, nfYarn], settings: { ...world().settings, customEngines: [fork, variant, program], modelRecipes: [old] } as Settings }));
    withPlans(api);
    renderLib('/models', api);
    let dialog = await openCommands('Qwen3.8-27B-NInfer');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Scrivi i comandi' }));
    const editor = await screen.findByRole('dialog', { name: 'Scrivi i comandi per Qwen3.8-27B-NInfer' });
    // One engine: no tabs; no YaRN (NInfer runs its models as trained); no llama.cpp choices.
    expect(within(editor).queryByRole('radiogroup', { name: 'Argomenti in più' })).toBeNull();
    expect(within(editor).queryByRole('radio', { name: 'Oltre il limite (YaRN)' })).toBeNull();
    expect(within(editor).queryByText('Decodifica speculativa (llama.cpp)')).toBeNull();
    expect(within(editor).getByLabelText('Variabili d’ambiente').getAttribute('placeholder')).toBeNull();
    expect(await engineOptions(editor)).toEqual(['Quello scelto nella pagina', 'NInfer', 'NInfer (WSL)', 'NInfer variante']);
    // One click adds a flag, a second takes it out; while a quote is open the chips wait.
    const args = within(editor).getByLabelText('Argomenti in più · NInfer') as HTMLTextAreaElement;
    const vision = within(editor).getByRole('button', { name: /--vision/ });
    expect(vision.getAttribute('aria-pressed')).toBe('false');
    await userEvent.click(vision);
    expect(args.value).toBe('--vision');
    expect(vision.getAttribute('aria-pressed')).toBe('true');
    await userEvent.type(args, ' --foo');
    await userEvent.click(within(editor).getByRole('button', { name: /--no-thinking/ }));
    expect(args.value).toBe('--vision --foo --no-thinking');
    await userEvent.click(vision);
    expect(args.value).toBe('--foo --no-thinking');
    fireEvent.change(args, { target: { value: '--foo "open' } });
    expect((within(editor).getByRole('button', { name: /--vision/ }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(args, { target: { value: '--foo --vision' } });
    await userEvent.click(within(editor).getByRole('button', { name: 'Salva' }));
    await waitFor(() => expect(saved(api)[0]).toMatchObject({ args: { ninfer: ['--foo', '--vision'] } }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Chiudi' }));
    // A recipe that already has YaRN keeps the choice.
    dialog = await openCommands('Qwen3.6-27B-NInfer');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Modifica' }));
    const edit = await screen.findByRole('dialog', { name: 'Modifica i comandi' });
    expect(within(edit).getByRole('radio', { name: 'Oltre il limite (YaRN)' }).getAttribute('aria-checked')).toBe('true');
  });

  it('a GGUF model: its engines (and the one already chosen), "Programma" when one is saved, every engine for a family', async () => {
    const m2 = localModel('m2');
    const r1 = recipe({ engine: { type: 'builtin', kind: 'vllm-docker' } });
    const r2 = modelRecipeSchema.parse({ id: 'm2', name: 'M2', match: { models: [{ label: 'x', weakKey: m2.identity.weakKey }] }, engine: { type: 'custom', id: 'v-fork' } });
    const api = libApi(world({ local: [M1, m2], settings: { ...world().settings, customEngines: [fork, vfork, variant, program], modelRecipes: [r1, r2] } as Settings }));
    withPlans(api);
    renderLib('/models', api);
    let dialog = await openCommands();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Modifica' }));
    let editor = await screen.findByRole('dialog', { name: 'Modifica i comandi' });
    expect(await engineOptions(editor)).toEqual(['Quello scelto nella pagina', 'llama.cpp', 'llama.cpp (Docker)', 'vLLM (Docker)', 'Il mio fork', 'Il mio programma']);
    // llama.cpp and the saved program; --jinja is already there.
    const tabs = within(editor).getByRole('radiogroup', { name: 'Argomenti in più' });
    expect(within(tabs).getAllByRole('radio').map((r) => r.textContent)).toEqual(['llama.cpp•', 'Programma']);
    const jinja = within(editor).getByRole('button', { name: /--jinja/ });
    expect(jinja.getAttribute('aria-pressed')).toBe('true');
    await userEvent.click(jinja);
    expect((within(editor).getByLabelText('Argomenti in più · llama.cpp') as HTMLTextAreaElement).value).toBe('');
    expect(within(editor).getByLabelText('Variabili d’ambiente').getAttribute('placeholder')).toBe('GGML_CUDA_GRAPH_OPT=1');
    // A program has no one-click arguments.
    await userEvent.click(within(tabs).getByRole('radio', { name: 'Programma' }));
    expect(within(editor).queryByRole('group', { name: 'Aggiungi con un clic' })).toBeNull();
    expect(within(editor).getByLabelText('Argomenti in più · Programma').getAttribute('placeholder')).toBe('');
    // A family can hold models of every format: every engine.
    await userEvent.click(within(editor).getByRole('radio', { name: 'Tutti i modelli di una famiglia' }));
    await userEvent.click(within(editor).getByRole('radio', { name: 'vLLM' }));
    const vllm = within(editor).getByLabelText('Argomenti in più · vLLM') as HTMLTextAreaElement;
    expect(vllm.getAttribute('placeholder')).toBe('--enable-chunked-prefill');
    await userEvent.click(within(editor).getByRole('button', { name: /--speculative-config/ }));
    expect(vllm.value).toBe('--speculative-config \'{"method":"mtp","num_speculative_tokens":1}\'');
    await userEvent.click(within(editor).getByRole('button', { name: /--speculative-config/ }));
    expect(vllm.value).toBe('');
    // Back to this model only: the empty vLLM tab goes, llama.cpp is shown again.
    await userEvent.click(within(editor).getByRole('radio', { name: 'Solo Model m1' }));
    expect(within(editor).getByLabelText('Argomenti in più · llama.cpp')).toBeTruthy();
    await userEvent.click(within(editor).getByRole('button', { name: 'Annulla' }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Chiudi' }));
    // A saved custom engine for another format, already chosen, stays in the list.
    dialog = await openCommands('Model m2');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Modifica' }));
    editor = await screen.findByRole('dialog', { name: 'Modifica i comandi' });
    expect(await engineOptions(editor)).toEqual(['Quello scelto nella pagina', 'llama.cpp', 'llama.cpp (Docker)', 'Il mio fork', 'Fork vLLM', 'Il mio programma']);
  });
});
