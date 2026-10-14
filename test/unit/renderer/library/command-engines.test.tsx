// "Programma con API OpenAI" on the Engines page: examples, commands before and after the server, the KV
// types of {kv}, what it takes from LLM Bench, the preview with example values, the check naming the
// command whose program is missing, and its card listing every command.
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { customEngineSchema, type CustomEngine } from '../../../../src/contract/custom-engines';
import { CheckView } from '../../../../src/renderer/components/engines/custom-engine-check';
import { renderUi } from '../helpers';
import { bridge, customCheck, customInfo, libApi, renderLib, system, world } from './fake';

vi.mock('echarts/core', () => ({ use: vi.fn(), init: vi.fn(() => ({ setOption: vi.fn(), resize: vi.fn(), dispose: vi.fn() })) }));
vi.mock('echarts/charts', () => ({ LineChart: {}, BarChart: {} }));
vi.mock('echarts/components', () => ({ AxisPointerComponent: {}, DataZoomComponent: {}, GridComponent: {}, LegendComponent: {}, MarkAreaComponent: {}, MarkLineComponent: {}, TooltipComponent: {} }));
vi.mock('echarts/renderers', () => ({ CanvasRenderer: {} }));

afterEach(() => {
  delete (window as { gpubench?: unknown }).gpubench;
  vi.restoreAllMocks();
});

const engine = (o: Partial<CustomEngine> & Pick<CustomEngine, 'id' | 'name' | 'base' | 'run'>): CustomEngine => customEngineSchema.parse(o);
const commandOk = (path: string) => customCheck({ kind: 'command', status: { kind: 'command', available: true, installed: true, location: path, problems: [], supported: true }, flagCount: 0, missing: [] });

describe('a program with an OpenAI API, step by step', () => {
  it('examples, commands before and after, KV types, what it takes, the preview, the check and the save', async () => {
    bridge();
    const w = world({ system: system({ os: { platform: 'linux', release: '6', arch: 'x64', name: 'Ubuntu 24.04', isWsl: false } }) });
    w.customCheck = () => commandOk('/usr/bin/python');
    const api = libApi(w);
    renderLib('/engines', api);
    await userEvent.click(await screen.findByRole('button', { name: 'Aggiungi motore' }));
    const dialog = await screen.findByRole('dialog', { name: 'Aggiungi un motore' });
    await userEvent.click(within(dialog).getByRole('radio', { name: /Programma con API OpenAI/ }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Avanti' }));
    await userEvent.type(within(dialog).getByLabelText('Nome'), 'Il mio script');

    // An example fills in every command.
    await userEvent.click(within(dialog).getByRole('button', { name: 'Uno script Python, con preparazione e pulizia' }));
    expect((within(dialog).getByLabelText('Prima di ogni avvio') as HTMLTextAreaElement).value).toBe('python prepare.py --model {model}');
    expect((within(dialog).getByLabelText('Dopo ogni arresto') as HTMLTextAreaElement).value).toBe('python cleanup.py');
    expect((within(dialog).getByRole('radio', { name: 'Chat (/v1/chat/completions)' }) as HTMLElement).getAttribute('aria-checked')).toBe('true');
    expect(within(dialog).getByText('Impostazioni di LLM Bench che usa: Contesto (token). Nel Benchmark compaiono solo queste.')).toBeTruthy();
    expect(within(dialog).getByText('«Trova le impostazioni migliori» può cercarle: i suoi comandi usano {ctx}.')).toBeTruthy();
    const preview = within(dialog).getByRole('region', { name: 'I comandi con valori di esempio' });
    expect(preview.textContent).toContain('# prima del server');
    expect(preview.textContent).toContain('python prepare.py --model "/home/me/models/Qwen3 8B/Qwen3-8B-Q4_K_M.gguf"');
    expect(preview.textContent).toContain('# dopo che il server si è fermato');
    // No {kv}: no KV types to choose.
    expect(within(dialog).queryByText('Tipi di cache KV che accetta al posto di {kv}')).toBeNull();

    // Like vLLM: {kv} in the command, its two types already chosen; none chosen is said.
    await userEvent.click(within(dialog).getByRole('button', { name: 'Un server come vLLM' }));
    const kv = within(dialog).getByRole('group', { name: 'Tipi di cache KV che accetta al posto di {kv}' });
    expect(within(kv).getAllByRole('checkbox').map((c) => c.getAttribute('aria-checked'))).toEqual(['false', 'true', 'false', 'true', 'false']);
    await userEvent.click(within(kv).getByRole('checkbox', { name: 'auto' }));
    await userEvent.click(within(kv).getByRole('checkbox', { name: 'fp8' }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Avanti' }));
    expect(within(dialog).getByText('Scegline almeno uno.')).toBeTruthy();
    await userEvent.click(within(kv).getByRole('checkbox', { name: 'fp8' }));
    expect(within(dialog).queryByText('Scegline almeno uno.')).toBeNull();
    expect(within(dialog).getByText(/Impostazioni di LLM Bench che usa: Contesto \(token\), Tipo di cache KV, Slot paralleli\./)).toBeTruthy();

    // A command before with a placeholder LLM Bench does not know: which line, which placeholder.
    const before = within(dialog).getByLabelText('Prima di ogni avvio');
    await userEvent.type(before, 'python fetch.py{enter}python warm.py --x {{nope}');
    expect(within(dialog).getByText('Riga 2: Non conosco {nope}: usa solo i segnaposto della lista.')).toBeTruthy();
    await userEvent.clear(before);
    await userEvent.type(before, 'python fetch.py --dir {{modelDir}');
    await userEvent.type(within(dialog).getByLabelText('Dopo ogni arresto'), 'python clean.py');

    // The placeholders explained; the check finds every program (it starts none).
    await userEvent.click(within(dialog).getByText('Cosa scrive LLM Bench al posto di ogni segnaposto'));
    expect(within(dialog).getByText('gli utenti insieme')).toBeTruthy();
    expect(within(dialog).getByText('Controllo i comandi e cerco i loro programmi: non li avvio.')).toBeTruthy();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Prova' }));
    expect(await within(dialog).findByText('Programmi trovati (3 comandi): il server è /usr/bin/python')).toBeTruthy();
    expect(api.calls.find((c) => c.path === '/api/engines/custom/check')?.body).toMatchObject({ run: { before: ['python fetch.py --dir {modelDir}'], after: ['python clean.py'], kvTypes: ['fp8'] } });

    await userEvent.click(within(dialog).getByRole('button', { name: 'Avanti' }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Salva motore' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(api.calls.find((c) => c.method === 'POST' && c.path === '/api/engines/custom')?.body).toMatchObject({
      name: 'Il mio script',
      base: 'openai-server',
      run: {
        mode: 'command',
        template: 'vllm serve {model} --host {host} --port {port} --served-model-name {alias} --max-model-len {ctx} --kv-cache-dtype {kv} --max-num-seqs {parallel}',
        api: 'completions',
        before: ['python fetch.py --dir {modelDir}'],
        after: ['python clean.py'],
        kvTypes: ['fp8'],
      },
    });
  });

  it('a command that takes no settings says so, and the search needs {ctx}', async () => {
    bridge();
    renderLib('/engines', libApi());
    await userEvent.click(await screen.findByRole('button', { name: 'Aggiungi motore' }));
    const dialog = await screen.findByRole('dialog', { name: 'Aggiungi un motore' });
    await userEvent.click(within(dialog).getByRole('radio', { name: /Programma con API OpenAI/ }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Avanti' }));
    // Nothing written yet: the preview says where it will appear.
    expect(within(dialog).getByText('Scrivi il comando (o scegli un esempio): qui lo vedi con i valori.')).toBeTruthy();
    await userEvent.type(within(dialog).getByLabelText('Comando che avvia il server'), 'srv --port {{port}');
    expect(within(dialog).getByText('Non usa impostazioni di LLM Bench: con {ctx}, {kv}, {parallel}… puoi sceglierle dal Benchmark.')).toBeTruthy();
    expect(within(dialog).getByText('«Trova le impostazioni migliori» ha bisogno di {ctx} in un comando.')).toBeTruthy();
    expect(within(dialog).getByRole('region', { name: 'I comandi con valori di esempio' }).textContent).toContain('srv --port 8080');
    // The commands before and after are folded until asked for.
    expect(within(dialog).queryByLabelText('Prima di ogni avvio')).toBeNull();
    await userEvent.click(within(dialog).getByRole('button', { name: '+ Comandi prima o dopo il server (facoltativi)' }));
    expect(within(dialog).getByLabelText('Prima di ogni avvio')).toBeTruthy();
  });

  it('the check names the command whose program is missing; the card lists every command', async () => {
    const run = { mode: 'command' as const, template: 'srv --port {port}', api: 'completions' as const };
    renderUi(
      <CheckView
        check={customCheck({ kind: 'command', status: { kind: 'command', available: false, installed: false, problems: ['ENGINE_NOT_INSTALLED'], problemParams: { reason: 'program_missing', path: 'prep', which: 'before', n: 2 }, supported: true }, flagCount: 0, missing: [] })}
        baseLabel="x"
        run={run}
      />,
    );
    expect(screen.getByText('Comando 2 prima del server: Non trovo il programma prep: controlla il percorso o che sia nel PATH.')).toBeTruthy();
    renderUi(
      <CheckView
        check={customCheck({ kind: 'command', status: { kind: 'command', available: false, installed: false, problems: ['VALIDATION'], problemParams: { reason: 'command_batch', path: 'C:\\x.bat', which: 'after', n: 1 }, supported: true }, flagCount: 0, missing: [] })}
        baseLabel="x"
        run={run}
      />,
    );
    expect(screen.getByText('Comando 1 dopo il server: Un file .bat o .cmd si avvia con cmd: scrivi «cmd /c C:\\x.bat …».')).toBeTruthy();

    document.body.innerHTML = '';
    bridge();
    const steps = engine({ id: 'steps', name: 'Con passi', base: 'openai-server', run: { mode: 'command', template: 'srv --port {port}', api: 'completions', before: ['prep a'], after: ['clean b'] } });
    const w = world({ settings: { ...world().settings, customEngines: [steps] } });
    w.custom = [customInfo(steps, commandOk('/usr/bin/srv'))];
    renderLib('/engines', libApi(w));
    const card = await screen.findByRole('region', { name: 'Con passi' });
    expect(within(card).getByText('prep a')).toBeTruthy();
    expect(within(card).getByText('clean b')).toBeTruthy();
    expect(within(card).getByText('prima del server')).toBeTruthy();
    expect(within(card).getByText('Programmi trovati (3 comandi): il server è /usr/bin/srv')).toBeTruthy();
    // Edited: the dialog shows its commands again.
    await userEvent.click(within(card).getByRole('button', { name: 'Modifica' }));
    const edit = await screen.findByRole('dialog', { name: 'Modifica Con passi' });
    expect((within(edit).getByLabelText('Prima di ogni avvio') as HTMLTextAreaElement).value).toBe('prep a');
  });
});
