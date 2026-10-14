import { QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { customEngineSchema, type CustomEngine } from '../../../../src/contract/custom-engines';
import { CheckView } from '../../../../src/renderer/components/engines/custom-engine-check';
import { ApiProvider } from '../../../../src/renderer/lib/api-context';
import { useDeleteCustomEngine } from '../../../../src/renderer/lib/queries-engines';
import { SETTINGS_QUERY_KEY } from '../../../../src/renderer/lib/settings';
import { newQueryClient, renderUi } from '../helpers';
import { bridge, customCheck, customInfo, ENGINES, fail, item, libApi, renderLib, report, system, world } from './fake';

vi.mock('echarts/core', () => ({ use: vi.fn(), init: vi.fn(() => ({ setOption: vi.fn(), resize: vi.fn(), dispose: vi.fn() })) }));
vi.mock('echarts/charts', () => ({ LineChart: {}, BarChart: {} }));
vi.mock('echarts/components', () => ({ AxisPointerComponent: {}, DataZoomComponent: {}, GridComponent: {}, LegendComponent: {}, MarkAreaComponent: {}, MarkLineComponent: {}, TooltipComponent: {} }));
vi.mock('echarts/renderers', () => ({ CanvasRenderer: {} }));

afterEach(() => {
  delete (window as { gpubench?: unknown }).gpubench;
  vi.restoreAllMocks();
});

const engine = (o: Partial<CustomEngine> & Pick<CustomEngine, 'id' | 'name' | 'base' | 'run'>): CustomEngine => customEngineSchema.parse(o);
const prism = engine({ id: 'prismml', name: 'PrismML', base: 'llamacpp', run: { mode: 'native', path: '/prism/llama-server' }, match: { names: ['bonsai'], quants: ['PQ2_0'], layouts: [] }, notes: 'Compilato con CUDA 13.' });
const card = (name: string) => screen.findByRole('region', { name });
const linux = system({ os: { platform: 'linux', release: '6', arch: 'x64', name: 'Ubuntu 24.04', isWsl: false } });

describe('Motori personalizzati', () => {
  it('starts empty, offers the PrismML template, and adds a llama.cpp fork step by step', async () => {
    const b = bridge({ pickFile: vi.fn(async () => '/prism/build/bin/llama-server') });
    const api = libApi();
    renderLib('/engines', api);
    expect(await screen.findByText('Nessun motore personalizzato')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Fork PrismML (modelli Bonsai)' })).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: 'Aggiungi motore' }));
    const dialog = await screen.findByRole('dialog', { name: 'Aggiungi un motore' });
    await userEvent.click(within(dialog).getByRole('radio', { name: /Fork di llama\.cpp/ }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Avanti' }));
    // Nothing filled in yet: "Avanti" says what is missing.
    await userEvent.click(within(dialog).getByRole('button', { name: 'Avanti' }));
    expect(within(dialog).getAllByText('Da compilare')).toHaveLength(2);
    await userEvent.type(within(dialog).getByLabelText('Nome'), 'PrismML');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Scegli file…' }));
    expect(b.pickFile).toHaveBeenCalledWith({ title: 'Il programma llama-server' });
    await waitFor(() => expect((within(dialog).getByLabelText('Il programma llama-server') as HTMLInputElement).value).toBe('/prism/build/bin/llama-server'));
    expect(within(dialog).queryByRole('button', { name: 'Scegli cartella…' })).toBeNull();

    await userEvent.click(within(dialog).getByRole('button', { name: 'Prova' }));
    expect(await within(dialog).findByText('Funziona · versione b7001')).toBeTruthy();
    expect(within(dialog).getByText('411 opzioni lette dal suo --help')).toBeTruthy();
    expect(within(dialog).getByText('Non conosce -ub (l’ubatch): userò il suo valore predefinito.')).toBeTruthy();
    expect(api.calls.find((c) => c.path === '/api/engines/custom/check')?.body).toMatchObject({ name: 'PrismML', run: { mode: 'native', path: '/prism/build/bin/llama-server' } });

    await userEvent.click(within(dialog).getByRole('button', { name: 'Avanti' }));
    await userEvent.type(within(dialog).getByLabelText('Argomenti in più'), '--ternary-kernels on');
    await userEvent.type(within(dialog).getByLabelText('Variabili d’ambiente'), 'non valida');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Salva motore' }));
    expect(await within(dialog).findByText('Riga 1: scrivi NOME=valore (il nome con lettere, cifre e _).')).toBeTruthy();
    await userEvent.clear(within(dialog).getByLabelText('Variabili d’ambiente'));
    await userEvent.type(within(dialog).getByLabelText('Variabili d’ambiente'), 'LD_LIBRARY_PATH=/prism/lib');
    await userEvent.type(within(dialog).getByLabelText('Parole nel nome del modello'), 'bonsai');
    await userEvent.type(within(dialog).getByLabelText('Quantizzazioni'), 'PQ2_0, PTQ1_0');
    await userEvent.type(within(dialog).getByLabelText('Note'), 'Mio fork');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Indietro' }));
    expect(within(dialog).getByLabelText('Nome')).toBeTruthy();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Avanti' }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Salva motore' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(api.calls.find((c) => c.method === 'POST' && c.path === '/api/engines/custom')?.body).toEqual({
      name: 'PrismML',
      base: 'llamacpp',
      run: { mode: 'native', path: '/prism/build/bin/llama-server' },
      extraArgs: ['--ternary-kernels', 'on'],
      env: { LD_LIBRARY_PATH: '/prism/lib' },
      notes: 'Mio fork',
      match: { names: ['bonsai'], quants: ['PQ2_0', 'PTQ1_0'] },
    });
    const saved = await card('PrismML');
    expect(within(saved).getByText('Funziona come llama.cpp')).toBeTruthy();
    expect(within(saved).getByText('Proposto per: bonsai, PQ2_0, PTQ1_0')).toBeTruthy();
    expect(within(saved).getByText('Mio fork')).toBeTruthy();
  });

  it('lists engines with their state, and edits, duplicates, deletes and uses them', async () => {
    bridge();
    const sglang = engine({ id: 'sg', name: 'SGLang team', base: 'sglang', run: { mode: 'docker', image: 'ghcr.io/team/sglang:fp4' } });
    const broken = engine({ id: 'old', name: 'Vecchio', base: 'llamacpp', run: { mode: 'native', path: '/gone/llama-server' } });
    const crash = engine({ id: 'crash', name: 'Rotto', base: 'llamacpp', run: { mode: 'native', path: '/x/llama-server' } });
    const strict = engine({ id: 'strict', name: 'Senza porta', base: 'llamacpp', run: { mode: 'native', path: '/y/llama-server' } });
    const mine = engine({ id: 'mine', name: 'Il mio server', base: 'openai-server', run: { mode: 'command', template: 'srv --port {port}', api: 'completions' } });
    const nohelp = engine({ id: 'nohelp', name: 'Senza aiuto', base: 'vllm', run: { mode: 'docker', image: 'me/vllm:1' } });
    const all = [prism, sglang, broken, crash, strict, mine, nohelp];
    const w = world({ settings: { ...world().settings, customEngines: all } });
    w.custom = [
      customInfo(prism),
      customInfo(sglang, customCheck({ kind: 'sglang-docker', status: { kind: 'sglang-docker', available: false, installed: false, problems: ['ENGINE_NOT_INSTALLED'], supported: true, location: 'ghcr.io/team/sglang:fp4' }, flagCount: 0, missing: [] })),
      customInfo(broken, customCheck({ status: { kind: 'llamacpp-native', available: false, installed: false, problems: ['ENGINE_NOT_INSTALLED'], supported: true }, flagCount: 0, missing: [] })),
      customInfo(crash, customCheck({ status: { kind: 'llamacpp-native', available: false, installed: true, problems: ['ENGINE_START_FAILED'], supported: true, location: '/x' }, flagCount: 0, missing: [] })),
      customInfo(strict, customCheck({ missing: [{ flag: '--port', setting: 'port', effect: 'required' }] })),
      customInfo(mine, customCheck({ kind: 'command', status: { kind: 'command', available: true, installed: true, location: '/usr/bin/srv', problems: [], supported: true }, flagCount: 0, missing: [], placeholders: ['port'] })),
      customInfo(nohelp, customCheck({ kind: 'vllm-docker', status: { kind: 'vllm-docker', available: true, installed: true, problems: [], supported: true }, flagCount: 0, missing: [] })),
    ];
    const api = libApi(w);
    const { router } = renderLib('/engines', api);

    const p = await card('PrismML');
    expect(within(p).getByText('Pronto')).toBeTruthy();
    expect(within(p).getByText('Compilato con CUDA 13.')).toBeTruthy();
    const s = await card('SGLang team');
    expect(within(s).getByText('L’immagine ghcr.io/team/sglang:fp4 non è ancora sul PC')).toBeTruthy();
    expect(within(s).getByText('Non installato')).toBeTruthy();
    await userEvent.click(within(s).getByRole('button', { name: 'Scarica l’immagine' }));
    await waitFor(() => expect(api.calls.find((c) => c.path === '/api/engines/sglang-docker/install')?.body).toEqual({ image: 'ghcr.io/team/sglang:fp4' }));
    expect(within(await card('Vecchio')).getByText('Non trovo /gone/llama-server')).toBeTruthy();
    expect(within(await card('Rotto')).getByText('Non parte')).toBeTruthy();
    const st = await card('Senza porta');
    expect(within(st).getByText('Manca --port (la porta): senza, LLM Bench non può avviarlo.')).toBeTruthy();
    expect((within(st).getByRole('button', { name: 'Usa nel Benchmark' }) as HTMLButtonElement).disabled).toBe(true);
    const m = await card('Il mio server');
    expect(within(m).getByText('Programma trovato: /usr/bin/srv')).toBeTruthy();
    expect(within(m).queryByText(/Funziona come/)).toBeNull();
    expect(within(await card('Senza aiuto')).getByText('Non riesco a leggere le sue opzioni (--help): userò le impostazioni di Fork di vLLM così come sono.')).toBeTruthy();

    // Edit: the dialog opens at "Dove si trova" with the saved values.
    await userEvent.click(within(p).getByRole('button', { name: 'Modifica' }));
    const edit = await screen.findByRole('dialog', { name: 'Modifica PrismML' });
    await userEvent.clear(within(edit).getByLabelText('Nome'));
    await userEvent.type(within(edit).getByLabelText('Nome'), 'PrismML 2');
    await userEvent.click(within(edit).getByRole('button', { name: 'Avanti' }));
    await userEvent.click(within(edit).getByRole('button', { name: 'Salva motore' }));
    await waitFor(() => expect(api.calls.some((c) => c.method === 'PUT' && c.path === '/api/engines/custom/prismml')).toBe(true));

    await userEvent.click(within(await card('PrismML 2')).getByRole('button', { name: 'Duplica' }));
    await waitFor(() => expect(api.calls.find((c) => c.path === '/api/engines/custom/prismml/duplicate')?.body).toEqual({ name: 'PrismML 2 (copia)' }));

    await userEvent.click(within(await card('Vecchio')).getByRole('button', { name: 'Elimina' }));
    // Nothing LLM Bench added for it: only forgotten, its files stay.
    const confirm = await screen.findByRole('dialog', { name: 'Eliminare Vecchio?' });
    expect(await within(confirm).findByText(/i suoi file restano dove sono/)).toBeTruthy();
    await userEvent.click(within(confirm).getByRole('button', { name: 'Elimina' }));
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Vecchio' })).toBeNull());

    await userEvent.click(within(await card('PrismML 2')).getByRole('button', { name: 'Usa nel Benchmark' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/'));
    expect(api.w.settings.lastEngine).toEqual({ kind: 'llamacpp-native', customEngineId: 'prismml' });
    // The Benchmark opens with it chosen.
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Cambia motore' }).textContent).toBe('llama.cpp · PrismML 2'));
  });

  it('opens from a deep link with the PrismML template, for the model that asked', async () => {
    bridge();
    const api = libApi();
    const { router } = renderLib('/engines?customTemplate=prismml-bonsai&modelName=Ternary-Bonsai-8B%20PQ2_0', api);
    const dialog = await screen.findByRole('dialog', { name: 'Aggiungi un motore' });
    expect(within(dialog).getByText('Serve per Ternary-Bonsai-8B PQ2_0')).toBeTruthy();
    expect((within(dialog).getByLabelText('Nome') as HTMLInputElement).value).toBe('Fork PrismML di llama.cpp');
    await userEvent.type(within(dialog).getByLabelText('Il programma llama-server'), '/prism/llama-server');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Avanti' }));
    expect((within(dialog).getByLabelText('Parole nel nome del modello') as HTMLInputElement).value).toBe('bonsai');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Salva motore' }));
    await waitFor(() => expect(router.state.location.search).toEqual({}));
    expect(api.calls.find((c) => c.method === 'POST' && c.path === '/api/engines/custom')?.body).toMatchObject({ template: 'prismml-bonsai', match: { names: ['bonsai'], quants: ['PQ2_0', 'PTQ1_0'] } });
  });

  it('a deep link that names the model by its weak key shows its library name', async () => {
    bridge();
    renderLib(`/engines?customTemplate=prismml-bonsai&model=${encodeURIComponent('local/m1-Q4_K_M.gguf/Q4_K_M/4294967296')}`, libApi());
    const dialog = await screen.findByRole('dialog', { name: 'Aggiungi un motore' });
    expect(await within(dialog).findByText('Serve per Model m1')).toBeTruthy();
  });

  it('a program with an OpenAI API: its command, the API to use, the check; save errors', async () => {
    bridge();
    const w = world();
    w.customCheck = () => customCheck({ kind: 'command', status: { kind: 'command', available: false, installed: false, problems: ['ENGINE_NOT_INSTALLED'], problemParams: { reason: 'program_missing', path: 'srv' }, supported: true }, flagCount: 0, missing: [] });
    const api = libApi(w);
    api.on('POST /api/engines/custom', () => fail('VALIDATION'));
    renderLib('/engines', api);
    await userEvent.click(await screen.findByRole('button', { name: 'Aggiungi motore' }));
    const dialog = await screen.findByRole('dialog', { name: 'Aggiungi un motore' });
    await userEvent.click(within(dialog).getByRole('radio', { name: /Programma con API OpenAI/ }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Avanti' }));
    await userEvent.type(within(dialog).getByLabelText('Nome'), 'Il mio server');
    // The check is not even sent with a template that cannot work.
    await userEvent.click(within(dialog).getByRole('button', { name: 'Prova' }));
    expect(await within(dialog).findByText('Scrivi il comando.')).toBeTruthy();
    await userEvent.type(within(dialog).getByLabelText('Comando che avvia il server'), 'srv --model {{model}');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Avanti' }));
    expect(within(dialog).getByText('Manca {port}: LLM Bench deve dire al programma su quale porta rispondere.')).toBeTruthy();
    await userEvent.type(within(dialog).getByLabelText('Comando che avvia il server'), ' --port {{port}');
    await userEvent.click(within(dialog).getByRole('radio', { name: 'Chat (/v1/chat/completions)' }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Prova' }));
    expect(await within(dialog).findByText('Non trovo il programma srv: controlla il percorso o che sia nel PATH.')).toBeTruthy();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Avanti' }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Salva motore' }));
    expect(await within(dialog).findByText('Alcuni valori non sono validi')).toBeTruthy();
    expect(api.calls.find((c) => c.method === 'POST' && c.path === '/api/engines/custom')?.body).toMatchObject({ run: { mode: 'command', template: 'srv --model {model} --port {port}', api: 'chat' } });
  });

  it('vLLM and SGLang forks: only Docker on Windows; checks that fail; Linux folders', async () => {
    const b = bridge();
    const w = world();
    w.customCheck = () => fail('DOCKER_NOT_RUNNING');
    renderLib('/engines', libApi(w));
    await userEvent.click(await screen.findByRole('button', { name: 'Aggiungi motore' }));
    let dialog = await screen.findByRole('dialog', { name: 'Aggiungi un motore' });
    await userEvent.click(within(dialog).getByRole('radio', { name: /Fork di SGLang/ }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Avanti' }));
    expect(await within(dialog).findByText('Su questo sistema SGLang si usa solo in Docker.')).toBeTruthy();
    expect((within(dialog).getByRole('radio', { name: 'Sul PC' }) as HTMLButtonElement).disabled).toBe(true);
    await userEvent.type(within(dialog).getByLabelText('Nome'), 'S');
    await userEvent.type(within(dialog).getByLabelText('Immagine Docker'), 'me/sglang:1');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Prova' }));
    expect(await within(dialog).findByText('Docker non è avviato')).toBeTruthy();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Indietro' }));
    await userEvent.click(within(dialog).getByRole('radio', { name: /Fork di vLLM/ }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Avanti' }));
    expect(within(dialog).getByText('Su questo sistema vLLM si usa solo in Docker.')).toBeTruthy();
    await userEvent.keyboard('{Escape}');

    // Linux: native vLLM, a venv folder.
    const w2 = world({ system: linux });
    w2.customCheck = () => customCheck({ kind: 'vllm-native', status: { kind: 'vllm-native', available: true, installed: true, problems: [], supported: true } });
    document.body.innerHTML = '';
    renderLib('/engines', libApi(w2));
    await userEvent.click(await screen.findByRole('button', { name: 'Aggiungi motore' }));
    dialog = await screen.findByRole('dialog', { name: 'Aggiungi un motore' });
    await userEvent.click(within(dialog).getByRole('radio', { name: /Fork di vLLM/ }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Avanti' }));
    await userEvent.type(within(dialog).getByLabelText('Nome'), 'V');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Scegli cartella…' }));
    expect(b.pickFolder).toHaveBeenCalledWith({ title: 'Il programma vllm o la sua cartella' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Prova' }));
    // A build that does not say its version still works.
    expect(await within(dialog).findByText('Funziona')).toBeTruthy();
    // Changing where it is forgets the check.
    await userEvent.click(within(dialog).getByRole('radio', { name: 'Immagine Docker' }));
    expect(within(dialog).queryByText('Funziona')).toBeNull();
    // A pick that is cancelled changes nothing; a check without a version still says it works.
    b.pickFile.mockResolvedValueOnce(null);
    await userEvent.click(within(dialog).getByRole('radio', { name: 'Sul PC' }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Scegli file…' }));
    expect((within(dialog).getByLabelText('Il programma vllm o la sua cartella') as HTMLInputElement).value).toBe('D:\\Picked');
  });
});

describe('SGLang cards', () => {
  it('Docker tags: use, download; native on Linux with uv first, then SGLang', async () => {
    bridge({ platform: 'linux' });
    const engines = [...ENGINES(), { kind: 'sglang-docker' as const, available: true, installed: true, problems: [], supported: true }, { kind: 'sglang-native' as const, available: false, installed: false, problems: ['ENGINE_NOT_INSTALLED'], supported: true }];
    // v0.5.21-cu130 is on the PC: it can be used; the others are downloaded first.
    const w = world({ system: linux, engines, check: report([item('vllm-native', { state: 'optional', action: { kind: 'install-uv', bytes: 20e6 } })]), images: { 'lmsysorg/sglang': [{ id: 'sha256:s1', tags: ['v0.5.21-cu130'], digests: [], sizeBytes: 14e9, running: false }] } });
    const api = libApi(w);
    renderLib('/engines', api);
    const docker = await card('SGLang (Docker)');
    const tags = await within(docker).findByRole('list', { name: 'Versioni di SGLang' });
    expect(within(tags).getAllByRole('listitem')).toHaveLength(6);
    expect(within(tags).getByText('Consigliato')).toBeTruthy();
    await userEvent.click(within(tags).getAllByRole('button', { name: 'Usa questa' })[0]!);
    await waitFor(() => expect(api.w.settings.lastEngine).toEqual({ kind: 'sglang-docker', image: 'lmsysorg/sglang:v0.5.21-cu130' }));
    expect(await within(tags).findByText('In uso')).toBeTruthy();
    await userEvent.click(within(docker).getByRole('button', { name: 'Tutte le versioni (8)' }));
    expect(within(tags).getAllByRole('listitem')).toHaveLength(8);
    await userEvent.click(within(docker).getByRole('button', { name: 'Mostra meno' }));
    await userEvent.click(within(tags).getAllByRole('button', { name: 'Scarica' })[0]!);
    expect(api.calls.find((c) => c.path === '/api/engines/sglang-docker/install')?.body).toEqual({ image: 'lmsysorg/sglang:v0.5.21' });

    const native = await card('SGLang nativo');
    expect(within(native).getByText('Non installato')).toBeTruthy();
    await userEvent.click(within(native).getByRole('button', { name: 'Prepara vLLM' }));
    expect(api.calls.some((c) => c.path === '/api/setup/uv/install')).toBe(true);
    act(() => api.emit({ type: 'engine.install', kind: 'uv', stage: 'error', bytesDone: 0, error: { code: 'NETWORK', message: 'x' } }));
    expect(await within(native).findByText('Connessione a internet non disponibile')).toBeTruthy();
  });

  it('native SGLang ready, or installed through its own button; hidden where it cannot run', async () => {
    bridge({ platform: 'linux' });
    const ready = [...ENGINES(), { kind: 'sglang-native' as const, available: true, installed: true, version: '0.5.21', problems: [], supported: true }];
    renderLib('/engines', libApi(world({ system: linux, engines: ready })));
    expect(within(await card('SGLang nativo')).getByText('SGLang 0.5.21')).toBeTruthy();

    document.body.innerHTML = '';
    const missing = [...ENGINES(), { kind: 'sglang-native' as const, available: false, installed: false, problems: ['ENGINE_NOT_INSTALLED'], supported: true }];
    const api = libApi(world({ system: linux, engines: missing }));
    renderLib('/engines', api);
    await userEvent.click(within(await card('SGLang nativo')).getByRole('button', { name: 'Installa SGLang' }));
    expect(api.calls.some((c) => c.path === '/api/engines/sglang-native/install')).toBe(true);
    act(() => api.emit({ type: 'engine.install', kind: 'sglang-native', stage: 'download', bytesDone: 1, bytesTotal: 2 }));
    expect(await within(await card('SGLang nativo')).findByRole('progressbar')).toBeTruthy();

    document.body.innerHTML = '';
    const windows = [...ENGINES(), { kind: 'sglang-native' as const, available: false, installed: false, problems: [], supported: false }];
    const docker = libApi(world({ engines: windows, docker: { state: 'stopped' } }));
    docker.on('GET /api/engines/sglang/tags', () => fail('NETWORK'));
    renderLib('/engines', docker);
    const card2 = await card('SGLang (Docker)');
    expect(within(card2).getByText('Serve Docker acceso')).toBeTruthy();
    expect(await within(card2).findByText('Connessione a internet non disponibile')).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'SGLang nativo' })).toBeNull();
  });
});

describe('Motori personalizzati: the check in words, the dialog on Linux, errors', () => {
  const nativeRun = { mode: 'native' as const, path: '/p/llama-server' };
  const down = (over: object) => ({ kind: 'llamacpp-native' as const, available: false, installed: true, problems: [] as string[], supported: true, ...over });

  it('the check: every option known, a setting it has no words for, a crash without a reason, a program found', () => {
    renderUi(<CheckView check={customCheck({ flagCount: 300, missing: [] })} baseLabel="llama.cpp" run={nativeRun} />);
    expect(screen.getByText('300 opzioni lette dal suo --help · Conosce tutte le impostazioni che LLM Bench usa.')).toBeTruthy();
    renderUi(<CheckView check={customCheck({ missing: [{ flag: '--x', setting: 'weird', effect: 'default' }] })} baseLabel="llama.cpp" run={nativeRun} />);
    expect(screen.getByText('Non conosce --x (weird): userò il suo valore predefinito.')).toBeTruthy();
    renderUi(<CheckView check={customCheck({ status: down({}), flagCount: 0, missing: [] })} baseLabel="llama.cpp" run={nativeRun} />);
    renderUi(<CheckView check={customCheck({ status: down({ problems: ['ENGINE_EXITED'], problemParams: { code: '1' }, location: '/p' }), flagCount: 0, missing: [] })} baseLabel="llama.cpp" run={nativeRun} />);
    expect(screen.getByText('Il motore non è partito')).toBeTruthy();
    expect(screen.getByText('Il motore si è chiuso all’improvviso')).toBeTruthy();
    // A reason in LLM Bench's own words that names no path.
    renderUi(<CheckView check={customCheck({ status: down({ problems: ['ENGINE_NOT_INSTALLED'], problemParams: { reason: 'command_missing' } }), flagCount: 0, missing: [] })} baseLabel="x" run={nativeRun} />);
    expect(screen.getByText('Manca il comando.')).toBeTruthy();
    renderUi(
      <CheckView
        check={customCheck({ kind: 'command', status: { kind: 'command', available: true, installed: true, problems: [], supported: true }, flagCount: 0, missing: [] })}
        baseLabel="x"
        run={{ mode: 'command', template: 'srv --port {port}', api: 'completions' }}
      />,
    );
    expect(screen.getByText('Programma trovato:')).toBeTruthy();
  });

  it('Linux: an SGLang fork’s Python, a pick cancelled, an image name that is not one, a check still running', async () => {
    const b = bridge({ platform: 'linux' });
    b.pickFile.mockResolvedValueOnce(null);
    const api = libApi(world({ system: linux }));
    let answer!: (v: unknown) => void;
    api.on('POST /api/engines/custom/check', () => new Promise((r) => (answer = r)));
    renderLib('/engines', api);
    await userEvent.click(await screen.findByRole('button', { name: 'Aggiungi motore' }));
    const dialog = await screen.findByRole('dialog', { name: 'Aggiungi un motore' });
    await userEvent.click(within(dialog).getByRole('radio', { name: /Fork di SGLang/ }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Avanti' }));
    const python = within(dialog).getByLabelText('Il Python con SGLang o la sua cartella') as HTMLInputElement;
    expect(within(dialog).getByText(/Il file python dell’ambiente dove è installato SGLang/)).toBeTruthy();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Scegli file…' }));
    expect(b.pickFile).toHaveBeenCalledWith({ title: 'Il Python con SGLang o la sua cartella' });
    expect(python.value).toBe('');
    await userEvent.type(within(dialog).getByLabelText('Nome'), 'SG');
    await userEvent.type(python, '/venv/bin/python');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Prova' }));
    expect(await within(dialog).findByText('Controllo in corso…')).toBeTruthy();
    act(() => answer(customCheck({ kind: 'sglang-native', status: { kind: 'sglang-native', available: true, installed: true, version: '0.5.21', problems: [], supported: true } })));
    expect(await within(dialog).findByText('Funziona · versione 0.5.21')).toBeTruthy();
    await userEvent.click(within(dialog).getByRole('radio', { name: 'Immagine Docker' }));
    await userEvent.type(within(dialog).getByLabelText('Immagine Docker'), 'Not An Image');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Avanti' }));
    expect(within(dialog).getByText('Il nome dell’immagine non è valido (per esempio ghcr.io/utente/immagine:versione).')).toBeTruthy();
    expect(within(dialog).getByLabelText('Immagine Docker').getAttribute('aria-invalid')).toBe('true');
  });

  it('the list cannot be read; the template button; duplicate and delete that fail', async () => {
    bridge();
    const broken = libApi();
    broken.on('GET /api/engines/custom', () => fail('NETWORK'));
    renderLib('/engines', broken);
    const section = await screen.findByRole('region', { name: 'Motori personalizzati' });
    expect(await within(section).findByText('Connessione a internet non disponibile')).toBeTruthy();

    document.body.innerHTML = '';
    const w = world({ settings: { ...world().settings, customEngines: [prism] } });
    w.custom = [customInfo(prism)];
    const api = libApi(w);
    api.on('POST /api/engines/custom/*/duplicate', () => fail('VALIDATION'));
    api.on('DELETE /api/engines/custom/*', () => fail('NETWORK'));
    renderLib('/engines', api);
    const p = await card('PrismML');
    await userEvent.click(within(p).getByRole('button', { name: 'Duplica' }));
    expect(await within(p).findByText('Alcuni valori non sono validi')).toBeTruthy();
    await userEvent.click(within(p).getByRole('button', { name: 'Elimina' }));
    const forget = await screen.findByRole('dialog', { name: 'Eliminare PrismML?' });
    await within(forget).findByText(/i suoi file restano dove sono/);
    await userEvent.click(within(forget).getByRole('button', { name: 'Elimina' }));
    expect(await within(forget).findByText('Connessione a internet non disponibile')).toBeTruthy();
    // It stays open on the error: closed by hand.
    await userEvent.click(within(forget).getByRole('button', { name: 'Annulla' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    // No engine yet: the built-in template opens the dialog filled in.
    document.body.innerHTML = '';
    renderLib('/engines', libApi());
    await userEvent.click(await screen.findByRole('button', { name: 'Fork PrismML (modelli Bonsai)' }));
    const dialog = await screen.findByRole('dialog', { name: 'Aggiungi un motore' });
    expect((within(dialog).getByLabelText('Nome') as HTMLInputElement).value).toBe('Fork PrismML di llama.cpp');
  });

  it('SGLang cards: a choice that cannot be saved, an install that failed without saying why', async () => {
    bridge({ platform: 'linux' });
    const engines = [...ENGINES(), { kind: 'sglang-docker' as const, available: true, installed: true, problems: [], supported: true }, { kind: 'sglang-native' as const, available: false, installed: false, problems: ['ENGINE_NOT_INSTALLED'], supported: true }];
    const api = libApi(world({ system: linux, engines, images: { 'lmsysorg/sglang': [{ id: 'sha256:s1', tags: ['v0.5.21-cu130'], digests: [], sizeBytes: 14e9, running: false }] } }));
    api.on('PUT /api/settings', () => fail('VALIDATION'));
    renderLib('/engines', api);
    const docker = await card('SGLang (Docker)');
    const tags = await within(docker).findByRole('list', { name: 'Versioni di SGLang' });
    await userEvent.click(within(tags).getAllByRole('button', { name: 'Usa questa' })[0]!);
    expect(await within(docker).findByText('Alcuni valori non sono validi')).toBeTruthy();
    act(() => api.emit({ type: 'engine.install', kind: 'sglang-native', stage: 'error', bytesDone: 0 }));
    expect(await within(await card('SGLang nativo')).findByText('Installazione del motore non riuscita')).toBeTruthy();
  });

  it('a change with no settings read yet leaves them unread', async () => {
    const qc = newQueryClient();
    const api = libApi(world({ custom: [customInfo(prism)] }));
    const wrapper = ({ children }: { children: ReactNode }) => (
      <ApiProvider api={api}>
        <QueryClientProvider client={qc}>{children}</QueryClientProvider>
      </ApiProvider>
    );
    const { result } = renderHook(() => useDeleteCustomEngine(), { wrapper });
    await act(() => result.current.mutateAsync({ id: 'prismml' }));
    expect(qc.getQueryData(SETTINGS_QUERY_KEY)).toBeUndefined();
  });
});
