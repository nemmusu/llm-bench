import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NativeEnvPlan } from '../../../../src/contract/native-envs';
import { ApiError } from '../../../../src/renderer/lib/api';
import { bridge, BUILDS, ENGINES, fail, item, libApi, okItems, renderLib, report, system, world } from './fake';

vi.mock('echarts/core', () => ({ use: vi.fn(), init: vi.fn(() => ({ setOption: vi.fn(), resize: vi.fn(), dispose: vi.fn() })) }));
vi.mock('echarts/charts', () => ({ LineChart: {}, BarChart: {} }));
vi.mock('echarts/components', () => ({ AxisPointerComponent: {}, DataZoomComponent: {}, GridComponent: {}, LegendComponent: {}, MarkAreaComponent: {}, MarkLineComponent: {}, TooltipComponent: {} }));
vi.mock('echarts/renderers', () => ({ CanvasRenderer: {} }));

afterEach(() => {
  delete (window as { gpubench?: unknown }).gpubench;
  vi.restoreAllMocks();
});

const h1 = (name: string | RegExp) => screen.findByRole('heading', { level: 1, name });
const card = (title: string) => screen.findByRole('region', { name: title });
const linux = system({ os: { platform: 'linux', release: '6', arch: 'x64', name: 'Ubuntu 24.04', isWsl: false } });

describe('engines: llama.cpp', () => {
  it('installed builds: use, remove, releases, latest, custom executable', async () => {
    const b = bridge();
    const api = libApi();
    renderLib('/engines', api);
    expect(await h1('Motori')).toBeTruthy();
    const llama = await card('llama.cpp');
    const builds = await within(llama).findByRole('list', { name: 'Versioni installate' });
    expect(within(builds).getAllByRole('listitem')).toHaveLength(2);
    expect(within(builds).getByText('CUDA 13.4')).toBeTruthy();
    expect(within(builds).getByText('vulkan')).toBeTruthy();
    expect(within(builds).getByText('In uso')).toBeTruthy();
    await userEvent.click(within(builds).getByRole('button', { name: 'Usa questa' }));
    await waitFor(() => expect(api.w.settings.lastEngine).toEqual({ kind: 'llamacpp-native', build: 'b10997' }));
    expect(api.calls.filter((c) => c.path === '/api/engines').length).toBeGreaterThan(1);
    await userEvent.click(within(builds).getByRole('button', { name: 'Rimuovi b11438' }));
    const confirm = await screen.findByRole('alertdialog', { name: 'Rimuovere llama.cpp b11438?' });
    await userEvent.click(within(confirm).getByRole('button', { name: 'Rimuovi' }));
    await waitFor(() => expect(api.calls.some((c) => c.method === 'DELETE' && c.path === '/api/engines/llamacpp/installed/b11438-cuda-13.4')).toBe(true));

    await userEvent.click(within(llama).getByRole('button', { name: 'Scegli versione…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Versioni di llama.cpp' });
    await userEvent.click(await within(dialog).findByRole('button', { name: 'Installa b11500' }));
    expect(api.calls.find((c) => c.path === '/api/engines/llamacpp-native/install')?.body).toEqual({ build: 'b11500' });
    act(() => api.emit({ type: 'engine.install', kind: 'llamacpp-native', stage: 'extract', bytesDone: 5, bytesTotal: 5 }));
    expect(await within(llama).findByText('Estrazione dei file')).toBeTruthy();
    act(() => api.emit({ type: 'engine.install', kind: 'llamacpp-native', stage: 'error', bytesDone: 0, error: { code: 'ENGINE_INSTALL_FAILED', message: 'x' } }));
    expect(await within(llama).findByText('Installazione del motore non riuscita')).toBeTruthy();
    // The update: the newest release against the build in use (b10997, chosen by hand), the choice back to "the newest".
    await userEvent.click(within(llama).getByRole('button', { name: 'Aggiorna' }));
    expect(api.calls.filter((c) => c.path === '/api/engines/llamacpp-native/install').pop()?.body).toEqual({ build: 'b11500' });
    await waitFor(() => expect(api.w.settings.lastEngine).toEqual({ kind: 'llamacpp-native' }));

    // A custom llama-server: validated by detecting it.
    api.w.engines = [{ ...ENGINES()[0]!, version: 'b9999', location: 'D:\\llama\\llama-server.exe' }];
    await userEvent.click(within(llama).getByRole('button', { name: 'Usa un eseguibile personalizzato…' }));
    expect(b.pickFile).toHaveBeenCalledWith({ title: 'Scegli llama-server', filters: [{ name: 'llama-server', extensions: ['exe'] }] });
    await waitFor(() => expect(api.w.settings.lastEngine).toEqual({ kind: 'llamacpp-native', executable: 'D:\\llama\\llama-server.exe' }));
    expect(await within(llama).findByText('Funziona · versione b9999')).toBeTruthy();
    expect(within(llama).queryByText('In uso')).toBeNull();
    await userEvent.click(within(llama).getByRole('button', { name: 'Usa la versione installata da LLM Bench' }));
    await waitFor(() => expect(api.w.settings.lastEngine).toEqual({ kind: 'llamacpp-native' }));
  });

  it('updates like every engine: available, then its progress in the card', async () => {
    const api = libApi();
    renderLib('/engines', api);
    const llama = await card('llama.cpp');
    expect(await within(llama).findByText('Aggiornamento disponibile: b11438 → b11500')).toBeTruthy();
    // No install button beside it: the update is the way to the newest.
    expect(within(llama).queryByRole('button', { name: /^Installa/ })).toBeNull();
    await userEvent.click(within(llama).getByRole('button', { name: 'Aggiorna' }));
    expect(api.calls.filter((c) => c.path === '/api/engines/llamacpp-native/install').pop()?.body).toEqual({ build: 'b11500' });
    // Nothing chosen by hand: the choice is left alone.
    expect(api.calls.some((c) => c.method === 'PUT' && c.path === '/api/settings')).toBe(false);
    act(() => api.emit({ type: 'engine.install', kind: 'llamacpp-native', stage: 'download', bytesDone: 1, bytesTotal: 5 }));
    expect(await within(llama).findByRole('progressbar', { name: 'Aggiornamento di llama.cpp' })).toBeTruthy();
    // Stopped without saying why: still said.
    act(() => api.emit({ type: 'engine.install', kind: 'llamacpp-native', stage: 'error', bytesDone: 0 }));
    expect(await within(llama).findByText('Installazione del motore non riuscita')).toBeTruthy();
  });

  it('the newest already installed but another in use: "Usa" it', async () => {
    const newest = { ...BUILDS()[0]!, id: 'b11500-cuda-13.4', tag: 'b11500' };
    const api = libApi(world({ builds: [newest, ...BUILDS()], settings: { ...world().settings, lastEngine: { kind: 'llamacpp-native', build: 'b11438' } } }));
    renderLib('/engines', api);
    const llama = await card('llama.cpp');
    expect(await within(llama).findByText('b11500 è installata, ma stai usando b11438')).toBeTruthy();
    await userEvent.click(within(llama).getByRole('button', { name: 'Usa b11500' }));
    await waitFor(() => expect(api.w.settings.lastEngine).toEqual({ kind: 'llamacpp-native', build: 'b11500' }));
  });

  it('up to date: says so and checks again; a failed check says so too', async () => {
    const newest = { ...BUILDS()[0]!, id: 'b11500-cuda-13.4', tag: 'b11500' };
    const api = libApi(world({ builds: [newest] }));
    renderLib('/engines', api);
    const llama = await card('llama.cpp');
    expect(await within(llama).findByText('Hai l’ultima versione (b11500)')).toBeTruthy();
    const before = api.calls.filter((c) => c.path === '/api/engines/llamacpp/releases').length;
    api.on('GET /api/engines/llamacpp/releases', () => fail('GITHUB_RATE_LIMITED', 429));
    await userEvent.click(within(llama).getByRole('button', { name: 'Controlla aggiornamenti' }));
    expect(await within(llama).findByText('Non riesco a controllare se ci sono aggiornamenti.')).toBeTruthy();
    expect(api.calls.filter((c) => c.path === '/api/engines/llamacpp/releases').length).toBeGreaterThan(before);
  });

  it('a custom executable that does not work, cancelled picks, errors', async () => {
    const b = bridge({ platform: 'linux', pickFile: vi.fn(async () => null) });
    const api = libApi(world({ settings: { ...world().settings, lastEngine: { kind: 'llamacpp-native', executable: '/opt/x/llama-server' } } }));
    api.w.engines = [{ kind: 'llamacpp-native', available: false, installed: false, problems: ['ENGINE_NOT_INSTALLED'], supported: true }];
    api.on('DELETE /api/engines/llamacpp/installed/*', () => fail('INTERNAL', 500));
    api.on('GET /api/engines/llamacpp/releases', () => fail('GITHUB_RATE_LIMITED', 429));
    renderLib('/engines', api);
    const llama = await card('llama.cpp');
    expect(await within(llama).findByText('Il motore non è installato')).toBeTruthy();
    expect(within(llama).getByText('Non installato')).toBeTruthy();
    await userEvent.click(within(llama).getByRole('button', { name: 'Usa un eseguibile personalizzato…' }));
    expect(b.pickFile).toHaveBeenCalledWith({ title: 'Scegli llama-server' });
    await userEvent.click(await within(llama).findByRole('button', { name: 'Rimuovi b10997' }));
    await userEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Annulla' }));
    await userEvent.click(within(llama).getByRole('button', { name: 'Rimuovi b10997' }));
    await userEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Rimuovi' }));
    expect(await within(llama).findByText('Si è verificato un errore imprevisto')).toBeTruthy();
    await userEvent.click(within(llama).getByRole('button', { name: 'Scegli versione…' }));
    expect(await within(await screen.findByRole('dialog')).findByText('GitHub ha limitato le richieste')).toBeTruthy();
  });

  it('broken install, installed-but-failing custom, builds error, save error', async () => {
    bridge();
    const api = libApi(world({ settings: { ...world().settings, lastEngine: { kind: 'llamacpp-native', executable: 'D:\\x.exe', build: 'b10997' } } }));
    api.w.engines = [{ kind: 'llamacpp-native', available: false, installed: true, problems: [], supported: true }];
    api.on('GET /api/engines/llamacpp/installed', () => fail('INTERNAL', 500));
    api.on('PUT /api/settings', () => fail('VALIDATION'));
    renderLib('/engines', api);
    const llama = await card('llama.cpp');
    expect(await within(llama).findByText('Non parte')).toBeTruthy();
    expect(await within(llama).findByText('Il motore non è partito')).toBeTruthy();
    expect(await within(llama).findByText('Si è verificato un errore imprevisto')).toBeTruthy();
    await userEvent.click(within(llama).getByRole('button', { name: 'Usa la versione installata da LLM Bench' }));
    expect(await within(llama).findByText('Alcuni valori non sono validi')).toBeTruthy();
  });

  it('a custom llama-server missing a system library: which one, and the command that fixes it', async () => {
    bridge({ platform: 'linux' });
    const api = libApi(world({ settings: { ...world().settings, lastEngine: { kind: 'llamacpp-native', executable: '/opt/llama/llama-server' } } }));
    api.w.engines = [
      { kind: 'llamacpp-native', available: false, installed: true, problems: ['ENGINE_MISSING_LIBRARY'], problemParams: { library: 'libgomp.so.1', package: 'libgomp1' }, supported: true },
    ];
    renderLib('/engines', api);
    const llama = await card('llama.cpp');
    expect(await within(llama).findByText('Manca una libreria di sistema: libgomp.so.1')).toBeTruthy();
    expect(within(llama).getByText(/esegui «sudo apt install libgomp1» e poi riprova/)).toBeTruthy();
  });

  it('builds without CUDA: the in-use one follows the saved build', async () => {
    const api = libApi(world({ settings: { ...world().settings, lastEngine: { kind: 'llamacpp-native', build: 'b10997-vulkan' } } }));
    renderLib('/engines', api);
    const builds = await screen.findByRole('list', { name: 'Versioni installate' });
    const rows = within(builds).getAllByRole('listitem');
    expect(within(rows[1]!).getByText('In uso')).toBeTruthy();
    expect(within(rows[0]!).getByRole('button', { name: 'Usa questa' })).toBeTruthy();
  });

  it('no builds yet: the install button is the primary action', async () => {
    const api = libApi(world({ builds: [] }));
    renderLib('/engines', api);
    const llama = await card('llama.cpp');
    expect(await within(llama).findByRole('button', { name: 'Installa' })).toBeTruthy();
  });
});

describe('engines: Docker', () => {
  it('stopped → start with progress (slow hint) → running', async () => {
    const api = libApi(world({ docker: { state: 'stopped' }, check: report([...okItems().slice(0, 5), item('docker', { state: 'optional', code: 'DOCKER_NOT_RUNNING', params: { dockerState: 'stopped' }, action: { kind: 'start-docker' } })]) }));
    renderLib('/engines', api);
    const docker = await card('Docker');
    expect(await within(docker).findByText('Spento')).toBeTruthy();
    await userEvent.click(within(docker).getByRole('button', { name: 'Avvia Docker' }));
    expect(api.calls.some((c) => c.path === '/api/docker/start')).toBe(true);
    act(() => api.emit({ type: 'engine.install', kind: 'docker-desktop', stage: 'starting', bytesDone: 65000, state: 'starting', slow: true }));
    expect(await within(docker).findByText(/ci sta mettendo più del solito/)).toBeTruthy();
    expect(within(docker).getByText('1 min 05 s')).toBeTruthy();
    expect(screen.getAllByRole('progressbar', { name: /Docker/ }).length).toBeGreaterThan(0);
    api.w.docker = { state: 'running', version: '29.8.0' };
    api.w.check = report(okItems());
    act(() => api.emit({ type: 'engine.install', kind: 'docker-desktop', stage: 'running', bytesDone: 0, state: 'running' }));
    expect(await within(docker).findByText('Acceso')).toBeTruthy();
    await waitFor(() => expect(api.calls.some((c) => c.path === '/api/setup/check?fresh=1')).toBe(true));
  });

  it('a failed start explains the problem', async () => {
    const api = libApi(world({ docker: { state: 'stopped' } }));
    renderLib('/engines', api);
    const docker = await card('Docker');
    await userEvent.click(await within(docker).findByRole('button', { name: 'Avvia Docker' }));
    act(() => api.emit({ type: 'engine.install', kind: 'docker-desktop', stage: 'error', bytesDone: 0, error: { code: 'DOCKER_NOT_RUNNING', message: 'timeout' } }));
    expect(await within(docker).findByText('Docker non è avviato')).toBeTruthy();
    act(() => api.emit({ type: 'engine.install', kind: 'docker-desktop', stage: 'error', bytesDone: 0 }));
    expect(await within(docker).findByText('Docker non è avviato')).toBeTruthy();
  });

  it('running: GPU check, image pull with progress, cleanup', async () => {
    const api = libApi();
    renderLib('/engines', api);
    const docker = await card('Docker');
    await userEvent.click(await within(docker).findByRole('button', { name: 'Verifica la GPU in Docker' }));
    expect(await within(docker).findByText('GPU 0: NVIDIA GeForce RTX 5090 (UUID: GPU-5090)')).toBeTruthy();
    await userEvent.click(within(docker).getByRole('button', { name: 'Scarica l’immagine di llama.cpp' }));
    expect(api.calls.find((c) => c.path === '/api/engines/llamacpp-docker/install')?.body).toEqual({ image: 'ghcr.io/ggml-org/llama.cpp:server-cuda' });
    act(() => api.emit({ type: 'engine.install', kind: 'llamacpp-docker', image: 'ghcr.io/ggml-org/llama.cpp:server-cuda', stage: 'download', bytesDone: 1e9, bytesTotal: 3e9 }));
    expect(await within(docker).findByText('954 MB di 2,8 GB · 33%')).toBeTruthy();
    act(() => api.emit({ type: 'engine.install', kind: 'llamacpp-docker', image: 'ghcr.io/ggml-org/llama.cpp:server-cuda', stage: 'done', bytesDone: 3e9, bytesTotal: 3e9 }));
    expect(await within(docker).findByText('Immagine pronta: ghcr.io/ggml-org/llama.cpp:server-cuda')).toBeTruthy();
    act(() => api.emit({ type: 'engine.install', kind: 'llamacpp-docker', image: 'ghcr.io/ggml-org/llama.cpp:server-cuda', stage: 'error', bytesDone: 0 }));
    expect(await within(docker).findByText('Download dell’immagine Docker non riuscito')).toBeTruthy();
    await userEvent.click(within(docker).getByRole('button', { name: 'Pulisci i contenitori di LLM Bench' }));
    expect(await screen.findByText('Contenitori rimossi: 1')).toBeTruthy();
  });

  it('the llama.cpp image on the PC: its size, "Aggiorna" pulls its tag again, removed after a confirmation, not while in use', async () => {
    const image = { id: 'sha256:llama', tags: ['server-cuda', 'latest'], digests: [], sizeBytes: 2.9e9, running: false };
    const api = libApi(world({ images: { 'ghcr.io/ggml-org/llama.cpp': [image] } }));
    renderLib('/engines', api);
    const docker = await card('Docker');
    expect(await within(docker).findByText('Immagine di llama.cpp sul PC · 2,7 GB')).toBeTruthy();
    expect(within(docker).queryByRole('button', { name: 'Scarica l’immagine di llama.cpp' })).toBeNull();
    await userEvent.click(within(docker).getByRole('button', { name: 'Aggiorna l’immagine di llama.cpp' }));
    expect(api.calls.find((c) => c.path === '/api/engines/llamacpp-docker/install')?.body).toEqual({ image: 'ghcr.io/ggml-org/llama.cpp:server-cuda' });
    act(() => api.emit({ type: 'engine.install', kind: 'llamacpp-docker', image: 'ghcr.io/ggml-org/llama.cpp:server-cuda', stage: 'error', bytesDone: 0 }));
    await userEvent.click(await within(docker).findByRole('button', { name: 'Rimuovi ghcr.io/ggml-org/llama.cpp:server-cuda' }));
    const confirm = await screen.findByRole('alertdialog', { name: 'Rimuovere ghcr.io/ggml-org/llama.cpp:server-cuda?' });
    expect(within(confirm).getByText(/Eseguo: docker image rm ghcr\.io\/ggml-org\/llama\.cpp:server-cuda/)).toBeTruthy();
    await userEvent.click(within(confirm).getByRole('button', { name: 'Rimuovi' }));
    expect(await within(docker).findByRole('button', { name: 'Scarica l’immagine di llama.cpp' })).toBeTruthy();

    api.w.images = { 'ghcr.io/ggml-org/llama.cpp': [{ ...image, running: true }] };
    api.on('POST /api/docker/images/remove', () => fail('DOCKER_PERMISSION', 500));
    act(() => api.emit({ type: 'engine.install', kind: 'llamacpp-docker', image: 'ghcr.io/ggml-org/llama.cpp:server-cuda', stage: 'done', bytesDone: 1 }));
    await userEvent.click(await within(docker).findByRole('button', { name: 'La sta usando un server o un test: fermalo, poi potrai rimuoverla' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    api.w.images = { 'ghcr.io/ggml-org/llama.cpp': [image] };
    act(() => api.emit({ type: 'engine.install', kind: 'llamacpp-docker', image: 'ghcr.io/ggml-org/llama.cpp:server-cuda', stage: 'done', bytesDone: 2 }));
    await userEvent.click(await within(docker).findByRole('button', { name: 'Rimuovi ghcr.io/ggml-org/llama.cpp:server-cuda' }));
    await userEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Rimuovi' }));
    expect(await within(docker).findByText('Non ho i permessi per usare Docker')).toBeTruthy();
  });

  it('GPU check and cleanup errors; a reason is shown when not running', async () => {
    const api = libApi(world({ docker: { state: 'no-gpu', reason: 'gpu-check-failed' } }));
    api.on('POST /api/docker/gpu-check', () => fail('DOCKER_NO_GPU'));
    api.on('POST /api/docker/cleanup', () => fail('DOCKER_PERMISSION'));
    renderLib('/engines', api);
    const docker = await card('Docker');
    expect(await within(docker).findByText('Motivo: gpu-check-failed')).toBeTruthy();
    await userEvent.click(within(docker).getByRole('button', { name: 'Verifica la GPU in Docker' }));
    expect(await within(docker).findByText('Docker non vede la scheda video')).toBeTruthy();
    await userEvent.click(within(docker).getByRole('button', { name: 'Pulisci i contenitori di LLM Bench' }));
    expect(await within(docker).findByText('Non ho i permessi per usare Docker')).toBeTruthy();
  });

  it('not installed on Windows: confirm with size and WSL notes, then install with progress', async () => {
    const api = libApi(world({ docker: { state: 'not-installed' } }));
    api.on('GET /api/setup/docker/plan', () => ({ platform: 'win32', kind: 'docker-desktop', supported: true, url: 'https://desktop.docker.com/i.exe', wsl: { available: false, meetsDockerMinimum: false } }));
    renderLib('/engines', api);
    const docker = await card('Docker');
    await userEvent.click(await within(docker).findByRole('button', { name: 'Installa Docker' }));
    const dialog = await screen.findByRole('dialog', { name: 'Installare Docker Desktop?' });
    expect(await within(dialog).findByText('desktop.docker.com')).toBeTruthy();
    expect(within(dialog).getByText('–')).toBeTruthy();
    expect(within(dialog).getByText(/Manca WSL 2/)).toBeTruthy();
    expect(within(dialog).getByText(/La versione di WSL è vecchia/)).toBeTruthy();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Scarica e installa' }));
    expect(api.calls.some((c) => c.path === '/api/setup/docker/install')).toBe(true);
    act(() => api.emit({ type: 'engine.install', kind: 'docker-desktop', stage: 'installer', bytesDone: 1, bytesTotal: 1 }));
    expect(await within(docker).findByText('Installazione: conferma la richiesta di Windows')).toBeTruthy();
  });

  it('install plan errors and unsupported PCs', async () => {
    const api = libApi(world({ docker: { state: 'not-installed' } }));
    let n = 0;
    api.on('GET /api/setup/docker/plan', () => (n++ === 0 ? fail('NETWORK', 502) : { platform: 'win32', kind: 'docker-desktop', supported: false, reason: 'unsupported-arch', arch: 'ia32' }));
    renderLib('/engines', api);
    const docker = await card('Docker');
    await userEvent.click(await within(docker).findByRole('button', { name: 'Installa Docker' }));
    expect(await within(await screen.findByRole('dialog')).findByText('Connessione a internet non disponibile')).toBeTruthy();
  });

  it('Linux: the exact script is shown before installing; permissions fixed the same way', async () => {
    const api = libApi(world({ system: linux, docker: { state: 'no-permission' } }));
    renderLib('/engines', api);
    const docker = await card('Docker');
    await userEvent.click(await within(docker).findByRole('button', { name: 'Installa Docker' }));
    const dialog = await screen.findByRole('dialog', { name: 'Installare Docker Engine?' });
    expect(await within(dialog).findByText('Docker Engine')).toBeTruthy();
    await userEvent.click(within(dialog).getByText('Mostra i comandi esatti'));
    expect(within(dialog).getByLabelText('Script di installazione').textContent).toContain('apt-get install docker-ce');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Installa' }));
    act(() => api.emit({ type: 'engine.install', kind: 'docker-linux', stage: 'nvidia-toolkit', bytesDone: 5, bytesTotal: 7 }));
    expect(await within(docker).findByText('Passo 5 di 7 · 71%')).toBeTruthy();
    act(() => api.emit({ type: 'engine.install', kind: 'docker-linux', stage: 'relogin-required', bytesDone: 7, bytesTotal: 7 }));
    expect(await within(docker).findByText('Permessi mancanti')).toBeTruthy();
  });

  it('Linux script errors; unknown, unsupported and starting states', async () => {
    const api = libApi(world({ system: linux, docker: { state: 'no-gpu' } }));
    api.on('GET /api/setup/docker/linux-script', () => fail('INTERNAL', 500));
    renderLib('/engines', api);
    const docker = await card('Docker');
    await userEvent.click(await within(docker).findByRole('button', { name: 'Installa Docker' }));
    expect(await within(await screen.findByRole('dialog')).findByText('Si è verificato un errore imprevisto')).toBeTruthy();
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Annulla' }));
  });

  it('unknown, unsupported and starting states only offer a re-check', async () => {
    const api = libApi(world({ docker: { state: 'unknown' } }));
    renderLib('/engines', api);
    const docker = await card('Docker');
    expect(await within(docker).findByText('Non riesco a capire lo stato di Docker: premi «Ricontrolla».')).toBeTruthy();
    api.w.docker = { state: 'unsupported', reason: 'podman' };
    await userEvent.click(within(docker).getByRole('button', { name: 'Ricontrolla' }));
    expect(await within(docker).findByText('Questa installazione di Docker non è supportata da LLM Bench.')).toBeTruthy();
    expect(within(docker).getByText('Motivo: podman')).toBeTruthy();
    api.w.docker = { state: 'starting' };
    await userEvent.click(within(docker).getByRole('button', { name: 'Ricontrolla' }));
    expect(await within(docker).findByText('Avvio in corso')).toBeTruthy();
  });
});

describe('engines: vLLM and others', () => {
  it('Docker tags with the recommended one, use and pull; show all', async () => {
    const api = libApi();
    renderLib('/engines', api);
    const vllm = await card('vLLM (Docker)');
    const tags = await within(vllm).findByRole('list', { name: 'Versioni di vLLM (immagini Docker)' });
    expect(within(tags).getAllByRole('listitem')).toHaveLength(6);
    expect(within(tags).getByText('Consigliato')).toBeTruthy();
    expect(within(tags).getByText('Non supporta la tua GPU')).toBeTruthy();
    // On the PC: its own size in the badge, not the download's.
    expect(within(tags).getByText('CUDA 13.0 · 4 ott 2026')).toBeTruthy();
    await userEvent.click(within(vllm).getByRole('button', { name: 'Tutte le versioni (8)' }));
    expect(within(tags).getAllByRole('listitem')).toHaveLength(8);
    await userEvent.click(within(vllm).getByRole('button', { name: 'Mostra meno' }));
    // v0.31.0 is on the PC (found by its digest): "Sul PC" with its size, one thing to do: use it.
    const v031 = within(tags).getAllByRole('listitem')[0]!;
    expect(within(v031).getByText('v0.31.0')).toBeTruthy();
    expect(within(v031).getByText('Sul PC · 30,1 GB')).toBeTruthy();
    expect(within(v031).queryByRole('button', { name: 'Scarica' })).toBeNull();
    // The others are not: "Scarica" only.
    const v090 = within(tags).getAllByRole('listitem')[1]!;
    expect(within(v090).queryByRole('button', { name: 'Usa questa' })).toBeNull();
    await userEvent.click(within(v031).getByRole('button', { name: 'Usa questa' }));
    await waitFor(() => expect(api.w.settings.lastEngine).toEqual({ kind: 'vllm-docker', image: 'vllm/vllm-openai:v0.31.0' }));
    expect(await within(tags).findByText('In uso')).toBeTruthy();
    expect(within(v031).queryByRole('button', { name: 'Usa questa' })).toBeNull();
    await userEvent.click(within(v090).getByRole('button', { name: 'Scarica' }));
    expect(api.calls.find((c) => c.path === '/api/engines/vllm-docker/install')?.body).toEqual({ image: 'vllm/vllm-openai:v0.9.0' });
    // Downloaded: read again, it is on the PC now.
    api.w.images = { 'vllm/vllm-openai': [...api.w.images['vllm/vllm-openai']!, { id: 'sha256:v090', tags: ['v0.9.0'], digests: [], sizeBytes: 8e9, running: false }] };
    act(() => api.emit({ type: 'engine.install', kind: 'vllm-docker', image: 'vllm/vllm-openai:v0.9.0', stage: 'done', bytesDone: 1 }));
    expect(await within(tags).findByText('Sul PC · 7,5 GB')).toBeTruthy();

    // Removed after a confirmation that says how much it frees and the command.
    await userEvent.click(within(tags).getByRole('button', { name: 'Rimuovi vllm/vllm-openai:v0.9.0' }));
    const confirm = await screen.findByRole('alertdialog', { name: 'Rimuovere vllm/vllm-openai:v0.9.0?' });
    expect(within(confirm).getByText(/Libera 7,5 GB sul disco di Docker.*Eseguo: docker image rm vllm\/vllm-openai:v0\.9\.0/)).toBeTruthy();
    await userEvent.click(within(confirm).getByRole('button', { name: 'Rimuovi' }));
    await waitFor(() => expect(within(tags).queryByText('Sul PC · 7,5 GB')).toBeNull());
    // Pulled by digest only: removed by its id.
    await userEvent.click(within(tags).getByRole('button', { name: 'Rimuovi vllm/vllm-openai:v0.31.0' }));
    await userEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Rimuovi' }));
    await waitFor(() => expect(api.calls.filter((c) => c.path === '/api/docker/images/remove').map((c) => c.body)).toEqual([{ image: 'vllm/vllm-openai:v0.9.0' }, { image: 'sha256:idx031' }]));
  });

  it('a version a server uses cannot be removed, and says why; one Docker Hub no longer lists stays usable; a failed removal is explained', async () => {
    const api = libApi(
      world({
        images: {
          'vllm/vllm-openai': [{ id: 'sha256:idx031', tags: ['v0.31.0'], digests: [], sizeBytes: 32.3e9, running: true }],
          'lmsysorg/sglang': [{ id: 'sha256:old', tags: ['v0.4.0'], digests: [], sizeBytes: 12e9, running: false }],
        },
      }),
    );
    api.on('POST /api/docker/images/remove', () => fail('DOCKER_IMAGE_IN_USE', 409));
    api.on('PUT /api/settings', () => fail('VALIDATION'));
    renderLib('/engines', api);
    const vllm = await card('vLLM (Docker)');
    const busy = await within(vllm).findByRole('button', { name: 'La sta usando un server o un test: fermalo, poi potrai rimuoverla' });
    await userEvent.click(busy);
    expect(screen.queryByRole('alertdialog')).toBeNull();
    // A choice that cannot be saved is said in the card.
    await userEvent.click(within(vllm).getByRole('button', { name: 'Usa questa' }));
    expect(await within(vllm).findByText('Alcuni valori non sono validi')).toBeTruthy();
    const sglang = await card('SGLang (Docker)');
    const list = await within(sglang).findByRole('list', { name: 'Versioni di SGLang' });
    expect(await within(list).findByText('v0.4.0')).toBeTruthy();
    expect(within(sglang).getByRole('button', { name: 'Tutte le versioni (9)' })).toBeTruthy();
    await userEvent.click(within(list).getByRole('button', { name: 'Rimuovi lmsysorg/sglang:v0.4.0' }));
    await userEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Rimuovi' }));
    expect(await within(sglang).findByText('Questa immagine è in uso')).toBeTruthy();
  });

  it('tags errors; Docker stopped disables pulls; save errors', async () => {
    const api = libApi(world({ docker: { state: 'stopped' } }));
    let n = 0;
    api.on('GET /api/engines/vllm/tags', () => (n++ === 0 ? fail('NETWORK', 502) : [{ name: 'v1' }]));
    api.on('PUT /api/settings', () => fail('VALIDATION'));
    renderLib('/engines', api);
    const vllm = await card('vLLM (Docker)');
    expect(await within(vllm).findByText('Connessione a internet non disponibile')).toBeTruthy();
    expect(within(vllm).getByText('Serve Docker acceso')).toBeTruthy();
  });

  it('vLLM on Linux: prepare uv, then install vLLM; errors; installed version', async () => {
    const api = libApi(
      world({
        system: linux,
        engines: [...ENGINES().slice(0, 3), { kind: 'vllm-native', available: false, installed: false, problems: [], supported: true }],
        check: report([...okItems().slice(0, 6), item('vllm-native', { state: 'optional', params: { uv: false }, action: { kind: 'install-uv', bytes: 2e7 } })], { platform: 'linux' }),
      }),
    );
    renderLib('/engines', api);
    const native = await card('vLLM (Linux)');
    await userEvent.click(await within(native).findByRole('button', { name: 'Prepara vLLM' }));
    expect(api.calls.some((c) => c.path === '/api/setup/uv/install')).toBe(true);
    act(() => api.emit({ type: 'engine.install', kind: 'uv', stage: 'download', bytesDone: 1e7, bytesTotal: 2e7 }));
    expect(await within(native).findByRole('progressbar', { name: 'vLLM (Linux)' })).toBeTruthy();
    act(() => api.emit({ type: 'engine.install', kind: 'uv', stage: 'failed', bytesDone: 0 }));
    api.w.check = report([...okItems().slice(0, 6), item('vllm-native', { state: 'optional', params: { uv: true }, action: { kind: 'install-vllm' } })], { platform: 'linux' });
    act(() => api.emit({ type: 'engine.install', kind: 'uv', stage: 'installed', bytesDone: 0 }));
    await userEvent.click(await within(native).findByRole('button', { name: 'Installa vLLM' }));
    expect(api.calls.some((c) => c.path === '/api/engines/vllm-native/install')).toBe(true);
    act(() => api.emit({ type: 'engine.install', kind: 'vllm-native', stage: 'error', bytesDone: 0 }));
    expect(await within(native).findByText('Installazione del motore non riuscita')).toBeTruthy();
    api.w.engines = [...ENGINES().slice(0, 3), { kind: 'vllm-native', available: true, installed: true, version: '0.11.0', problems: [], supported: true }];
    api.w.check = report([...okItems().slice(0, 6), item('vllm-native', { params: { version: '0.11.0' } })], { platform: 'linux' });
    act(() => api.emit({ type: 'engine.install', kind: 'vllm-native', stage: 'done', bytesDone: 0 }));
    expect(await within(native).findByText('Versione installata: 0.11.0')).toBeTruthy();
    expect(within(native).getByText('Pronto')).toBeTruthy();
  });

  const VENV = '/home/u/.local/share/LLM Bench/engines/vllm-venv';
  const vllmEnv = (over: Partial<NativeEnvPlan> = {}): NativeEnvPlan => ({ kind: 'vllm-native', supported: true, installed: true, folder: VENV, sizeBytes: 9e9, files: 41000, busy: false, ...over });

  it("vLLM on Linux: LLM Bench's environment removed after a confirmation (folder, size, results stay), then the install again", async () => {
    const api = libApi(
      world({
        system: linux,
        engines: [...ENGINES().slice(0, 3), { kind: 'vllm-native', available: true, installed: true, version: '0.11.0', problems: [], supported: true }],
        check: report([...okItems().slice(0, 6), item('vllm-native', { params: { version: '0.11.0' } })], { platform: 'linux' }),
        nativeEnvs: { 'vllm-native': vllmEnv() },
      }),
    );
    renderLib('/engines', api);
    const native = await card('vLLM (Linux)');
    expect(await within(native).findByText(`Installato da LLM Bench in ${VENV} · 8,4 GB`)).toBeTruthy();
    // Cancelled: nothing removed.
    await userEvent.click(within(native).getByRole('button', { name: 'Rimuovi vLLM (Linux)' }));
    await userEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Annulla' }));
    expect(api.calls.some((c) => c.method === 'DELETE')).toBe(false);

    await userEvent.click(within(native).getByRole('button', { name: 'Rimuovi vLLM (Linux)' }));
    const confirm = await screen.findByRole('alertdialog', { name: 'Rimuovere vLLM (Linux)?' });
    expect(within(confirm).getByText(`Elimino la cartella ${VENV} (8,4 GB, 41000 file)`, { exact: false })).toBeTruthy();
    expect(within(confirm).getByText(/Risultati, modelli e impostazioni restano/)).toBeTruthy();
    api.w.engines = [...ENGINES().slice(0, 3), { kind: 'vllm-native', available: false, installed: false, problems: ['ENGINE_NOT_INSTALLED'], supported: true }];
    api.w.check = report([...okItems().slice(0, 6), item('vllm-native', { state: 'optional', params: { uv: true }, action: { kind: 'install-vllm' } })], { platform: 'linux' });
    await userEvent.click(within(confirm).getByRole('button', { name: 'Rimuovi' }));
    await waitFor(() => expect(api.calls.some((c) => c.method === 'DELETE' && c.path === '/api/engines/vllm-native/environment')).toBe(true));
    expect(await within(native).findByRole('button', { name: 'Installa vLLM' })).toBeTruthy();
    await waitFor(() => expect(within(native).queryByRole('button', { name: 'Rimuovi vLLM (Linux)' })).toBeNull());
    expect(within(native).getByText('Non installato')).toBeTruthy();
  });

  it('vLLM on Linux: not while a test or a server runs (said on the button), the core refusing is shown', async () => {
    const api = libApi(world({ system: linux, nativeEnvs: { 'vllm-native': vllmEnv({ busy: true }) } }));
    renderLib('/engines', api);
    const native = await card('vLLM (Linux)');
    const busy = await within(native).findByRole('button', { name: 'Un test, un server o un’installazione sta usando vLLM (Linux): fermalo, poi potrai rimuoverlo' });
    expect(busy.getAttribute('aria-disabled')).toBe('true');
    // The test ended: a click asks again, no confirmation yet.
    api.w.nativeEnvs = { 'vllm-native': vllmEnv() };
    await userEvent.click(busy);
    expect(screen.queryByRole('alertdialog')).toBeNull();

    // Free as far as the card knew, busy for the core: its error.
    api.on('DELETE /api/engines/*/environment', () => {
      throw new ApiError({ code: 'ENGINE_IN_USE', message: 'in use', params: { engine: 'vLLM' } }, 500);
    });
    await userEvent.click(await within(native).findByRole('button', { name: 'Rimuovi vLLM (Linux)' }));
    await userEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Rimuovi' }));
    expect(await within(native).findByText('vLLM è in uso')).toBeTruthy();
  });

  it("SGLang on Linux: the user's own environment is theirs (said, no removal)", async () => {
    const own = '/home/u/venvs/sglang';
    const api = libApi(
      world({
        system: linux,
        engines: [...ENGINES().slice(0, 3), { kind: 'sglang-native', available: true, installed: true, version: '0.5.21', problems: [], supported: true }],
        nativeEnvs: { 'sglang-native': { kind: 'sglang-native', supported: true, installed: false, folder: '/e/sglang-venv', sizeBytes: 0, files: 0, own, busy: false } },
      }),
    );
    renderLib('/engines', api);
    const native = await card('SGLang nativo');
    expect(await within(native).findByText(`Questo ambiente Python è tuo (${own}): LLM Bench lo usa e non lo rimuove mai.`)).toBeTruthy();
    expect(within(native).queryByRole('button', { name: /^Rimuovi/ })).toBeNull();
  });

  it('external server opens the Benchmark in expert mode', async () => {
    const api = libApi();
    const { router } = renderLib('/engines', api);
    await userEvent.click(await screen.findByRole('button', { name: 'Configura nel Benchmark' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/'));
    expect(api.w.settings.expertMode).toBe(true);
    expect(api.w.settings.lastEngine).toEqual({ kind: 'external' });
  });
});

describe('system check actions', () => {
  it('Docker install, uv, vLLM, free disk, docs and model picking from the Engines page', async () => {
    const b = bridge({ platform: 'linux' });
    const api = libApi(
      world({
        system: linux,
        check: report(
          [
            ...okItems().slice(0, 3),
            item('models', { state: 'missing', code: 'MODEL_NOT_FOUND', action: { kind: 'pick-model' } }),
            item('disk', { state: 'warning', code: 'DISK_FULL', params: { freeGb: 3, path: '/', minFreeGb: 20 }, action: { kind: 'free-disk', bytes: 17e9 } }),
            item('docker', { state: 'optional', code: 'DOCKER_NOT_INSTALLED', params: { dockerState: 'not-installed' }, action: { kind: 'install-docker-linux' } }),
            item('vllm-native', { state: 'optional', params: { uv: true }, action: { kind: 'install-vllm' } }),
          ],
          { platform: 'linux' },
        ),
      }),
    );
    const { router } = renderLib('/engines', api);
    const panel = (await screen.findByRole('heading', { level: 2, name: 'Controllo del sistema' })).closest('section') as HTMLElement;
    await userEvent.click(await within(panel).findByRole('button', { name: 'Installa Docker (Docker)' }));
    const dialog = await screen.findByRole('dialog', { name: 'Installare Docker Engine?' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Installa' }));
    await waitFor(() => expect(api.calls.some((c) => c.path === '/api/setup/docker/install')).toBe(true));
    act(() => api.emit({ type: 'engine.install', kind: 'docker-linux', stage: 'docker-repo', bytesDone: 3, bytesTotal: 7 }));
    expect(await within(panel).findByText('Archivio di Docker')).toBeTruthy();
    act(() => api.emit({ type: 'engine.install', kind: 'docker-linux', stage: 'relogin-required', bytesDone: 7, bytesTotal: 7 }));
    expect(await within(panel).findByText(/esci dalla sessione e rientra/)).toBeTruthy();
    await userEvent.click(within(panel).getByRole('button', { name: 'Installa vLLM (vLLM (Linux))' }));
    expect(api.calls.some((c) => c.path === '/api/engines/vllm-native/install')).toBe(true);
    await userEvent.click(within(panel).getByRole('button', { name: /Scegli un’altra cartella/ }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/settings'));
    await router.navigate({ to: '/engines' });
    await userEvent.click(await screen.findByRole('button', { name: 'Scegli un modello (Modelli)' }));
    // A first model: the verified suggestions, not the whole of Hugging Face.
    await waitFor(() => expect(router.state.location.search).toEqual({ tab: 'download', view: 'curated' }));
    expect(b.openExternal).not.toHaveBeenCalled();
  });

  it('setup job failures show the error of their last event; reboot notes; unsupported distro docs; check errors per item', async () => {
    const b = bridge();
    const api = libApi(
      world({
        check: report([
          item('driver', { state: 'warning', code: 'INTERNAL', error: { code: 'INTERNAL', message: 'timeout' } }),
          ...okItems().slice(1, 5),
          item('docker', { state: 'optional', code: 'DOCKER_NOT_INSTALLED', params: { dockerState: 'not-installed' }, action: { kind: 'install-docker', bytes: 6e8 } }),
          item('vllm-native', { state: 'warning', params: { dockerState: 'no-permission', distroSupport: 'unsupported-distro', docs: 'https://docs.docker.com/engine/install/' } }),
        ]),
      }),
    );
    renderLib('/engines', api);
    const panel = (await screen.findByRole('heading', { level: 2, name: 'Controllo del sistema' })).closest('section') as HTMLElement;
    expect(await within(panel).findByText('Non sono riuscito a controllarlo: premi «Ricontrolla».')).toBeTruthy();
    await userEvent.click(within(panel).getByRole('button', { name: 'Apri la guida di Docker' }));
    expect(b.openExternal).toHaveBeenCalledWith('https://docs.docker.com/engine/install/');
    await userEvent.click(within(panel).getByRole('button', { name: 'Installa Docker · 572 MB (Docker)' }));
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Annulla' }));
    await userEvent.click(within(panel).getByRole('button', { name: 'Installa Docker · 572 MB (Docker)' }));
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Scarica e installa' }));
    // The job's last event carries its error: no extra request to read it.
    act(() => api.emit({ type: 'engine.install', kind: 'docker-desktop', stage: 'failed', bytesDone: 0, error: { code: 'DOCKER_INSTALL_FAILED', message: 'exit 1' } }));
    expect(await within(panel).findByText('Installazione di Docker non riuscita')).toBeTruthy();
    expect(api.calls.some((c) => c.path.startsWith('/api/setup/jobs'))).toBe(false);
    act(() => api.emit({ type: 'engine.install', kind: 'docker-desktop', stage: 'reboot-maybe-required', bytesDone: 0 }));
    expect(await within(panel).findByText(/riavvia il PC per completare/)).toBeTruthy();
    act(() => api.emit({ type: 'engine.install', kind: 'docker-desktop', stage: 'failed', bytesDone: 0 }));
    expect(await within(panel).findByText('Si è verificato un errore imprevisto')).toBeTruthy();
  });

  it('a start request that fails at once shows the error in the row', async () => {
    const api = libApi(world({ check: report([...okItems().slice(0, 5), item('docker', { state: 'optional', params: { dockerState: 'stopped' }, action: { kind: 'start-docker' } })]) }));
    api.on('POST /api/docker/start', () => fail('DOCKER_UNSUPPORTED'));
    renderLib('/engines', api);
    const panel = (await screen.findByRole('heading', { level: 2, name: 'Controllo del sistema' })).closest('section') as HTMLElement;
    await userEvent.click(await within(panel).findByRole('button', { name: 'Avvia Docker (Docker)' }));
    expect(await within(panel).findByText('Questa versione di Docker non è supportata')).toBeTruthy();
  });

  it('a working custom executable that reports no version; save errors; plan for an unsupported PC; panel re-check', async () => {
    const api = libApi(world({ settings: { ...world().settings, lastEngine: { kind: 'llamacpp-native', executable: 'D:\\x.exe' } }, docker: { state: 'not-installed' } }));
    api.w.engines = [{ ...ENGINES()[0]!, version: undefined }, ...ENGINES().slice(1)];
    let n = 0;
    api.on('GET /api/setup/docker/plan', () => (n++ === 0 ? fail('NETWORK', 502) : { platform: 'win32', kind: 'docker-desktop', supported: false, reason: 'unsupported-arch', arch: 'ia32' }));
    renderLib('/engines', api);
    expect(await screen.findByText('Funziona · versione –')).toBeTruthy();
    const docker = await card('Docker');
    await userEvent.click(await within(docker).findByRole('button', { name: 'Installa Docker' }));
    await within(await screen.findByRole('dialog')).findByText('Connessione a internet non disponibile');
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Annulla' }));
    await userEvent.click(within(docker).getByRole('button', { name: 'Installa Docker' }));
    expect(await within(await screen.findByRole('dialog')).findByText(/processore non supportato/)).toBeTruthy();
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Annulla' }));
    const panel = (await screen.findByRole('heading', { level: 2, name: 'Controllo del sistema' })).closest('section') as HTMLElement;
    await userEvent.click(within(panel).getAllByRole('button', { name: 'Ricontrolla' })[0]!);
    await waitFor(() => expect(api.calls.some((c) => c.path === '/api/setup/check?fresh=1')).toBe(true));
    api.on('PUT /api/settings', () => fail('VALIDATION'));
    const llama = await card('llama.cpp');
    await userEvent.click((await within(llama).findAllByRole('button', { name: 'Usa questa' }))[0]!);
    expect(await within(llama).findByText('Alcuni valori non sono validi')).toBeTruthy();
  });
});
