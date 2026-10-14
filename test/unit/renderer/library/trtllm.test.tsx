/** Engines → TensorRT-LLM: its two ways (Docker, native / in WSL), each with its state and one thing to do. */
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LocalImage } from '../../../../src/contract/docker';
import type { EngineStatus } from '../../../../src/contract/engines';
import {
  dockerModeState,
  firstVersion,
  imageInUse,
  initialMode,
  nativeModeState,
  nativeNeed,
  sortVersions,
  trtllmStatus,
  trtllmVersions,
  type TrtllmVersion,
} from '../../../../src/renderer/components/engines/trtllm-format';
import { isRtx50 } from '../../../../src/renderer/components/engines/trtllm-card';
import { TRTLLM_REPO } from '../../../../src/renderer/lib/queries-trtllm';
import { ENGINES, fail, libApi, renderLib, system, world, type LibApi } from './fake';

vi.mock('echarts/core', () => ({ use: vi.fn(), init: vi.fn(() => ({ setOption: vi.fn(), resize: vi.fn(), dispose: vi.fn() })) }));
vi.mock('echarts/charts', () => ({ LineChart: {}, BarChart: {} }));
vi.mock('echarts/components', () => ({ AxisPointerComponent: {}, DataZoomComponent: {}, GridComponent: {}, LegendComponent: {}, MarkAreaComponent: {}, MarkLineComponent: {}, TooltipComponent: {} }));
vi.mock('echarts/renderers', () => ({ CanvasRenderer: {} }));

afterEach(() => {
  vi.restoreAllMocks();
});

const IMAGE = (v: string) => `${TRTLLM_REPO}:${v}`;
const GB = 1024 ** 3;
const linux = system({ os: { platform: 'linux', release: '6', arch: 'x64', name: 'Ubuntu 24.04', isWsl: false } });
const card = () => screen.findByRole('region', { name: 'TensorRT-LLM' });
const calls = (api: LibApi, method: string, path: string) => api.calls.filter((c) => c.method === method && c.path === path);
/** The two ways' switch (a radio group). */
const pick = async (c: HTMLElement, name: RegExp) => userEvent.click(await within(await within(c).findByRole('radiogroup', { name: 'Come usarlo' })).findByRole('radio', { name }));
/** The card's own status, top right (each way also says its state in the switch, under its name). */
const status = (c: HTMLElement, text: string) => waitFor(() => expect(within(c).getAllByText(text)[0]?.className).toContain('shrink-0'));

/** The Docker engine's status: the recommended image in use, on the PC or not. */
const dockerStatus = (over: Partial<EngineStatus> = {}): EngineStatus => ({ kind: 'trtllm-docker', available: false, installed: false, location: IMAGE('1.2.0'), version: '1.2.0', problems: ['ENGINE_NOT_INSTALLED'], supported: true, ...over });
/** The native engine's status: inside WSL's Ubuntu, not installed. */
const nativeStatus = (over: Partial<EngineStatus> = {}): EngineStatus => ({
  kind: 'trtllm-native',
  available: false,
  installed: false,
  variant: 'Ubuntu-24.04',
  location: '~/.llm-bench/trtllm-venv/bin/python',
  problems: ['ENGINE_NOT_INSTALLED'],
  problemParams: { reason: 'python_missing' },
  supported: true,
  ...over,
});
const installedNative = (over: Partial<EngineStatus> = {}) => nativeStatus({ available: true, installed: true, version: '1.2.0', location: '/home/me/.llm-bench/trtllm-venv/bin/python', problems: [], ...over });
const engines = (docker: Partial<EngineStatus> = {}, native: Partial<EngineStatus> | EngineStatus = {}) => [...ENGINES(), dockerStatus(docker), 'kind' in native ? (native as EngineStatus) : nativeStatus(native)];
const image = (over: Partial<LocalImage> = {}): LocalImage => ({ id: 'sha256:aaa', tags: ['1.2.0'], digests: [], sizeBytes: 20 * GB, running: false, ...over });
/** The versions Docker has of NVIDIA's repository. */
const withImages = (api: LibApi, list: LocalImage[]) => api.on('GET /api/docker/images', (_b, q) => (q.get('repo') === TRTLLM_REPO ? list : []));

describe('Engines → TensorRT-LLM, Docker', () => {
  it('nothing on the PC: one primary download of the recommended version, its progress; the others behind "Tutte le versioni"', async () => {
    const api = libApi(world({ engines: engines() }));
    withImages(api, []);
    renderLib('/engines', api);
    const c = await card();
    expect(await within(c).findByText('Il motore di NVIDIA: spesso il più veloce con i modelli FP8 e NVFP4. Legge i modelli di Hugging Face (safetensors).')).toBeTruthy();
    await status(c, 'Non installato');
    // An RTX 5090: experimental, said plainly.
    expect(within(c).getByText('Sperimentale sulla tua scheda')).toBeTruthy();
    expect(within(c).getByRole('radio', { name: /Docker/ }).getAttribute('aria-checked')).toBe('true');
    expect(within(c).getByText(/dentro Docker Desktop \(usa la scheda video tramite WSL 2\)/)).toBeTruthy();
    expect(within(c).queryByRole('list', { name: 'Versioni di TensorRT-LLM (immagini Docker)' })).toBeNull();
    await userEvent.click(await within(c).findByRole('button', { name: /^Scarica TensorRT-LLM 1\.2\.0 · 20,5 GB$/ }));
    expect(calls(api, 'POST', '/api/engines/trtllm-docker/install')[0]?.body).toEqual({ image: IMAGE('1.2.0') });
    act(() => api.emit({ type: 'engine.install', kind: 'trtllm-docker', image: IMAGE('1.2.0'), stage: 'download', bytesDone: 5e9, bytesTotal: 22e9 }));
    expect(await within(c).findByRole('progressbar')).toBeTruthy();
    act(() => api.emit({ type: 'engine.install', kind: 'trtllm-docker', image: IMAGE('1.2.0'), stage: 'error', bytesDone: 0, error: { code: 'DOCKER_PULL_FAILED', message: 'x' } }));
    expect(await within(c).findByRole('button', { name: /^Scarica TensorRT-LLM 1\.2\.0/ })).toBeTruthy();
    act(() => api.emit({ type: 'engine.install', kind: 'trtllm-docker', image: IMAGE('1.2.0'), stage: 'error', bytesDone: 0 }));
    await userEvent.click(within(c).getByRole('button', { name: 'Tutte le versioni (3)' }));
    const list = within(c).getByRole('list', { name: 'Versioni di TensorRT-LLM (immagini Docker)' });
    const rows = within(list).getAllByRole('listitem');
    expect(rows).toHaveLength(3);
    expect(within(rows[0] as HTMLElement).getByText('Anteprima')).toBeTruthy();
    expect(within(rows[0] as HTMLElement).getByText('21,4 GB')).toBeTruthy();
    expect(within(rows[1] as HTMLElement).getByText('Consigliato')).toBeTruthy();
    await userEvent.click(within(rows[0] as HTMLElement).getByRole('button', { name: 'Scarica' }));
    expect(calls(api, 'POST', '/api/engines/trtllm-docker/install')[1]?.body).toEqual({ image: IMAGE('1.3.0rc2') });
    act(() => api.emit({ type: 'engine.install', kind: 'trtllm-docker', image: IMAGE('1.3.0rc2'), stage: 'done', bytesDone: 23e9 }));
    expect(await within(c).findByText(`Immagine pronta: ${IMAGE('1.3.0rc2')}`)).toBeTruthy();
    await userEvent.click(within(c).getByRole('button', { name: 'Meno versioni' }));
    expect(within(c).queryByRole('list')).toBeNull();
  });

  it('versions on the PC (by tag or by digest): "Sul PC" with the size, "Usa questa" then "In uso", each removed after a confirmation', async () => {
    const api = libApi(world({ engines: engines({ installed: true, available: true, problems: [] }) }));
    withImages(api, [image({ id: 'sha256:120', tags: [], digests: [] }), image({ id: 'sha256:old', tags: ['0.9.0'], sizeBytes: 15 * GB })]);
    api.on('POST /api/docker/images/remove', () => ({ ok: true }));
    renderLib('/engines', api);
    const c = await card();
    await status(c, 'Pronto');
    const list = await within(c).findByRole('list', { name: 'Versioni di TensorRT-LLM (immagini Docker)' });
    const rows = () => within(list).getAllByRole('listitem');
    // The ones on the PC first: 1.2.0 (found by its digest), then 0.9.0 (NGC no longer lists it).
    expect(rows().map((r) => r.getAttribute('data-local'))).toEqual(['true', 'true', null, null]);
    const r120 = rows()[0] as HTMLElement;
    expect(within(r120).getByText('Sul PC · 20,0 GB')).toBeTruthy();
    expect(within(r120).getByText('In uso')).toBeTruthy();
    expect(within(c).queryByRole('button', { name: /^Scarica TensorRT-LLM/ })).toBeNull();
    const r090 = rows()[1] as HTMLElement;
    await userEvent.click(within(r090).getByRole('button', { name: 'Usa questa' }));
    await waitFor(() => expect(calls(api, 'PUT', '/api/settings')[0]?.body).toEqual({ lastEngine: { kind: 'trtllm-docker', image: IMAGE('0.9.0') } }));
    expect(await within(r090).findByText('In uso')).toBeTruthy();
    // Another version: removed by its image.
    await userEvent.click(within(r120).getByRole('button', { name: 'Rimuovi 1.2.0' }));
    let dialog = await screen.findByRole('alertdialog', { name: 'Rimuovere TensorRT-LLM 1.2.0?' });
    expect(within(dialog).getByText(`Libero 20,0 GB sul disco con «docker image rm ${IMAGE('1.2.0')}». I risultati dei test restano nello storico e puoi riscaricarla quando vuoi.`)).toBeTruthy();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Rimuovi' }));
    await waitFor(() => expect(calls(api, 'POST', '/api/docker/images/remove')[0]?.body).toEqual({ image: IMAGE('1.2.0') }));
    expect(await screen.findByText('TensorRT-LLM 1.2.0 rimosso')).toBeTruthy();
    // The one in use: the same way, by its image.
    await userEvent.click(within(r090).getByRole('button', { name: 'Rimuovi 0.9.0' }));
    dialog = await screen.findByRole('alertdialog', { name: 'Rimuovere TensorRT-LLM 0.9.0?' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Rimuovi' }));
    await waitFor(() => expect(calls(api, 'POST', '/api/docker/images/remove')[1]?.body).toEqual({ image: IMAGE('0.9.0') }));
  });

  it('a version a server uses cannot go; an update is offered', async () => {
    const api = libApi(
      world({
        engines: engines({ installed: true, available: true, problems: [] }),
        updates: {
          'trtllm-docker': { target: 'trtllm-docker', method: 'docker-tag', state: 'available', current: '1.2.0', latest: '1.3.0', sizeBytes: 23e9, commands: [['docker', 'pull', IMAGE('1.3.0')]], checkedAt: '2026-10-14T00:00:00Z' },
        },
      }),
    );
    withImages(api, [image({ running: true })]);
    renderLib('/engines', api);
    const c = await card();
    const list = await within(c).findByRole('list', { name: 'Versioni di TensorRT-LLM (immagini Docker)' });
    const row = within(list).getAllByRole('listitem')[0] as HTMLElement;
    expect(await within(row).findByText('In uso')).toBeTruthy();
    expect(within(row).queryByRole('button', { name: 'Usa questa' })).toBeNull();
    await userEvent.click(within(row).getByRole('button', { name: 'Un server o un test la sta usando: si può rimuovere quando ha finito' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(await within(c).findByText('Aggiornamento disponibile: 1.2.0 → 1.3.0 · 21,4 GB')).toBeTruthy();
  });

  it('without the list of local images: the engine status says the image in use is there (no size); a tag of the user’s own is listed', async () => {
    const api = libApi(world({ engines: engines({ installed: true, available: true, problems: [], location: 'my/trtllm:dev', version: 'dev' }), settings: { ...world().settings, lastEngine: { kind: 'trtllm-docker', image: 'my/trtllm:dev' } } }));
    renderLib('/engines', api);
    const c = await card();
    const list = await within(c).findByRole('list', { name: 'Versioni di TensorRT-LLM (immagini Docker)' });
    const row = within(list).getAllByRole('listitem')[0] as HTMLElement;
    expect(within(row).getByText('dev')).toBeTruthy();
    expect(within(row).getByText('Sul PC')).toBeTruthy();
    await userEvent.click(within(row).getByRole('button', { name: 'Rimuovi dev' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText('La cancello dal disco con «docker image rm my/trtllm:dev». I risultati dei test restano nello storico e puoi riscaricarla quando vuoi.')).toBeTruthy();
  });

  it('a refused removal and a failed choice are explained', async () => {
    const api = libApi(world({ engines: engines() }));
    withImages(api, [image({ tags: ['1.1.0'] })]);
    api.on('POST /api/docker/images/remove', () => fail('DOCKER_IMAGE_IN_USE' as never, 409));
    api.on('PUT /api/settings', () => fail('INTERNAL', 500));
    renderLib('/engines', api);
    const c = await card();
    await userEvent.click(await within(c).findByRole('button', { name: 'Usa questa' }));
    await userEvent.click(within(c).getByRole('button', { name: 'Rimuovi 1.1.0' }));
    await userEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Rimuovi' }));
    await waitFor(() => expect(within(c).getAllByRole('note').length).toBeGreaterThanOrEqual(3));
  });

  it('Docker off on Windows: why, and "Avvia Docker" with its progress; downloads wait for it', async () => {
    const api = libApi(world({ docker: { state: 'stopped' }, engines: engines() }));
    renderLib('/engines', api);
    const c = await card();
    expect(await within(c).findByText('Docker è spento: avvialo e TensorRT-LLM è pronto a partire.')).toBeTruthy();
    expect(within(c).getByRole('button', { name: /^Scarica TensorRT-LLM 1\.2\.0/ }).hasAttribute('disabled')).toBe(true);
    await userEvent.click(within(c).getByRole('button', { name: 'Avvia Docker' }));
    expect(calls(api, 'POST', '/api/docker/start')).toHaveLength(1);
    act(() => api.emit({ type: 'engine.install', kind: 'docker-desktop', stage: 'starting', bytesDone: 4000, state: 'starting' }));
    expect(await within(c).findByRole('progressbar', { name: 'Docker' })).toBeTruthy();
  });

  it('Docker off with a version on the PC: the card says Docker is what is missing', async () => {
    renderLib('/engines', libApi(world({ docker: { state: 'stopped' }, engines: engines({ installed: true, problems: ['DOCKER_NOT_RUNNING'] }) })));
    await status(await card(), 'Serve Docker acceso');
  });

  it('Docker missing: "Installa Docker" opens the guided install', async () => {
    const api = libApi(world({ docker: { state: 'not-installed' }, engines: engines() }));
    renderLib('/engines', api);
    const c = await card();
    expect(await within(c).findByText(/Serve Docker\. Su Windows è Docker Desktop/)).toBeTruthy();
    await userEvent.click(within(c).getByRole('button', { name: 'Installa Docker' }));
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Scarica e installa' }));
    await waitFor(() => expect(calls(api, 'POST', '/api/setup/docker/install')).toHaveLength(1));
  });

  it('Docker stuck: "Riavvia Docker" in its dialog, and the restart’s progress in the card', async () => {
    const api = libApi(world({ docker: { state: 'not-responding' }, engines: engines() }));
    renderLib('/engines', api);
    const c = await card();
    expect(await within(c).findByText('Docker è aperto ma non risponde: va riavviato.')).toBeTruthy();
    await userEvent.click(within(c).getByRole('button', { name: 'Riavvia Docker' }));
    await waitFor(() => expect(calls(api, 'POST', '/api/docker/restart')).toHaveLength(1));
    act(() => api.emit({ type: 'engine.install', kind: 'docker-restart', stage: 'restart', step: 1, steps: 3, bytesDone: 0 }));
    expect((await within(c).findAllByText('Riavvio di Docker Desktop')).length).toBeGreaterThan(0);
  });

  it('Linux: Docker off gives the command in its dialog', async () => {
    const api = libApi(world({ system: linux, docker: { state: 'stopped' }, engines: engines() }));
    renderLib('/engines', api);
    const c = await card();
    expect(await within(c).findByText(/Su Linux è un servizio del sistema: premi «Come avviarlo»/)).toBeTruthy();
    expect(within(c).getByText(/L’immagine ufficiale di NVIDIA, dentro Docker: il modo più semplice/)).toBeTruthy();
    expect(within(c).getByRole('radio', { name: /Sul PC/ })).toBeTruthy();
    await userEvent.click(within(c).getByRole('button', { name: 'Come avviarlo' }));
    expect(await screen.findByRole('dialog', { name: 'Docker è spento' })).toBeTruthy();
  });

  it('Linux, Docker without the GPU: its support installed with the guided script', async () => {
    const api = libApi(world({ system: linux, docker: { state: 'no-gpu' }, engines: engines() }));
    renderLib('/engines', api);
    const c = await card();
    expect(await within(c).findByText(/non vede la scheda video/)).toBeTruthy();
    await userEvent.click(within(c).getByRole('button', { name: 'Installa Docker' }));
    await userEvent.click(within(await screen.findByRole('dialog', { name: 'Installare Docker Engine?' })).getByRole('button', { name: 'Installa' }));
    await waitFor(() => expect(calls(api, 'POST', '/api/setup/docker/install')).toHaveLength(1));
  });

  it('Docker’s state not read yet: said as unknown, with "Ricontrolla"', async () => {
    const api = libApi(world({ engines: engines() }));
    api.on('GET /api/docker/status', () => fail('INTERNAL', 500));
    renderLib('/engines', api);
    const c = await card();
    expect(await within(c).findByText('Non so in che stato è Docker: premi «Ricontrolla».')).toBeTruthy();
  });

  it('a recommended version NGC gives no size for: the download names the version only', async () => {
    const api = libApi(world({ engines: engines(), trtllmTags: [{ name: '1.2.0', recommended: true, prerelease: false }] }));
    withImages(api, []);
    renderLib('/engines', api);
    expect(await within(await card()).findByRole('button', { name: 'Scarica TensorRT-LLM 1.2.0' })).toBeTruthy();
  });

  it('Docker in an unknown state: "Ricontrolla" asks again', async () => {
    const api = libApi(world({ docker: { state: 'unknown' }, engines: engines() }));
    renderLib('/engines', api);
    const c = await card();
    const button = await within(c).findByRole('button', { name: 'Ricontrolla' });
    const before = calls(api, 'GET', '/api/docker/status').length;
    await userEvent.click(button);
    await waitFor(() => expect(calls(api, 'GET', '/api/docker/status').length).toBeGreaterThan(before));
  });

  it('Docker starting: nothing to press, only to wait', async () => {
    renderLib('/engines', libApi(world({ docker: { state: 'starting' }, engines: engines() })));
    const c = await card();
    expect(await within(c).findByText('Docker si sta avviando: di solito ci vuole circa un minuto.')).toBeTruthy();
    expect(within(c).queryByRole('button', { name: 'Ricontrolla' })).toBeNull();
  });

  it('NGC unreachable: only the versions on the PC, said, with "Riprova"', async () => {
    const api = libApi(world({ engines: engines() }));
    withImages(api, [image({ tags: ['1.0.0'] })]);
    let n = 0;
    api.on('GET /api/engines/trtllm/tags', () => (n++ === 0 ? fail('INTERNAL', 500) : api.w.trtllmTags));
    renderLib('/engines', api);
    const c = await card();
    expect(await within(c).findByText('Non riesco a leggere le versioni da NVIDIA (NGC): vedi solo quelle sul PC.')).toBeTruthy();
    expect(within(c).getByText('1.0.0')).toBeTruthy();
    await userEvent.click(within(c).getByRole('button', { name: 'Riprova' }));
    expect(await within(c).findByText('1.2.0')).toBeTruthy();
  });

  it('no versions at all: said', async () => {
    const api = libApi(world({ trtllmTags: [], engines: engines() }));
    withImages(api, []);
    renderLib('/engines', api);
    const c = await card();
    expect(await within(c).findByText('Nessuna versione da mostrare: controlla la connessione e riprova.')).toBeTruthy();
  });
});

describe('Engines → TensorRT-LLM, native (in WSL on Windows)', () => {
  it('no WSL: what it needs with its command; "Ricontrolla" asks the whole system again', async () => {
    const api = libApi(world({ engines: engines({}, { problemParams: { reason: 'wsl_missing' } }) }));
    renderLib('/engines', api);
    const c = await card();
    await pick(c, /In WSL/);
    const needs = await within(c).findByRole('region', { name: 'Cosa serve' });
    expect(within(needs).getByText('WSL 2')).toBeTruthy();
    expect(within(needs).getByText('Manca')).toBeTruthy();
    expect(within(needs).getByText(/Apri PowerShell come amministratore/)).toBeTruthy();
    expect(within(needs).getByRole('region', { name: 'Comando per: WSL 2' }).textContent).toContain('wsl --install');
    expect(within(c).queryByRole('button', { name: 'Installa TensorRT-LLM' })).toBeNull();
    await userEvent.click(within(needs).getByRole('button', { name: 'Ricontrolla' }));
    await waitFor(() => expect(calls(api, 'GET', '/api/setup/check?fresh=1')).toHaveLength(1));
  });

  it('WSL without a distro: the command that installs Ubuntu; a failed "Ricontrolla" is explained', async () => {
    const api = libApi(world({ engines: engines({}, { problemParams: { reason: 'distro_missing' } }) }));
    api.on('GET /api/setup/check', (_b, q) => (q.get('fresh') === '1' ? fail('INTERNAL', 500) : api.w.check));
    renderLib('/engines', api);
    const c = await card();
    await status(c, 'Non installato');
    await pick(c, /In WSL/);
    const needs = await within(c).findByRole('region', { name: 'Cosa serve' });
    expect(within(needs).getByRole('region', { name: 'Comando per: Una distribuzione Linux in WSL' }).textContent).toContain('wsl --install -d Ubuntu-24.04');
    await userEvent.click(within(needs).getByRole('button', { name: 'Ricontrolla' }));
    await waitFor(() => expect(within(needs).getAllByRole('note').length).toBeGreaterThan(0));
  });

  it('not installed: one primary install and its progress; a failure is explained', async () => {
    const api = libApi(world({ engines: engines() }));
    renderLib('/engines', api);
    const c = await card();
    await pick(c, /In WSL/);
    expect(within(c).getByText(/dentro una distribuzione Linux di WSL/)).toBeTruthy();
    expect(within(c).getByText(/Lo installo dentro Ubuntu-24\.04, in un ambiente Python tutto suo/)).toBeTruthy();
    await userEvent.click(within(c).getByRole('button', { name: 'Installa TensorRT-LLM' }));
    expect(calls(api, 'POST', '/api/engines/trtllm-native/install')).toHaveLength(1);
    act(() => api.emit({ type: 'engine.install', kind: 'trtllm-native', stage: 'download', bytesDone: 1e9, bytesTotal: 3.2e9 }));
    expect(await within(c).findByRole('progressbar', { name: 'Installazione di TensorRT-LLM' })).toBeTruthy();
    act(() => api.emit({ type: 'engine.install', kind: 'trtllm-native', stage: 'error', bytesDone: 0, error: { code: 'NETWORK', message: 'uv' } }));
    expect(await within(c).findByRole('button', { name: 'Installa TensorRT-LLM' })).toBeTruthy();
    expect(within(c).getAllByRole('note').length).toBeGreaterThan(1);
    act(() => api.emit({ type: 'engine.install', kind: 'trtllm-native', stage: 'error', bytesDone: 0 }));
    expect(await within(c).findByText('Installazione del motore non riuscita')).toBeTruthy();
  });

  it('Linux: installed on the PC itself; a status without a distro', async () => {
    renderLib('/engines', libApi(world({ system: linux, engines: engines({}, { variant: undefined }) })));
    const c = await card();
    await pick(c, /Sul PC/);
    expect(within(c).getByText('Installato in un ambiente Python tutto suo: non tocca il resto del sistema.')).toBeTruthy();
    expect(within(c).getByText(/^Lo installo in un ambiente Python tutto suo/)).toBeTruthy();
  });

  it('installed and in use: shown first, its version, folder and "In uso"; removal after a confirmation', async () => {
    const api = libApi(world({ engines: engines({}, installedNative()), settings: { ...world().settings, lastEngine: { kind: 'trtllm-native' } } }));
    api.on('DELETE /api/engines/trtllm-native/install', () => {
      api.w.engines = engines();
      return { ok: true };
    });
    renderLib('/engines', api);
    const c = await card();
    await status(c, 'Pronto');
    expect(within(c).getByRole('radio', { name: /In WSL/ }).getAttribute('aria-checked')).toBe('true');
    expect(within(c).getByText('1.2.0')).toBeTruthy();
    expect(within(c).getByText('Sul PC')).toBeTruthy();
    expect(within(c).getByText('In uso')).toBeTruthy();
    expect(within(c).getByText('Ubuntu-24.04: /home/me/.llm-bench/trtllm-venv/bin/python')).toBeTruthy();
    expect(within(c).queryByRole('button', { name: 'Usa questo' })).toBeNull();
    await userEvent.click(within(c).getByRole('button', { name: 'Rimuovi TensorRT-LLM 1.2.0' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Rimuovere TensorRT-LLM 1.2.0?' });
    expect(within(dialog).getByText(/Cancello il suo ambiente \(\/home\/me\/\.llm-bench\/trtllm-venv\/bin\/python\)/)).toBeTruthy();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Rimuovi' }));
    await waitFor(() => expect(calls(api, 'DELETE', '/api/engines/trtllm-native/install')).toHaveLength(1));
    expect(await screen.findByText('TensorRT-LLM rimosso')).toBeTruthy();
    expect(await within(c).findByRole('button', { name: 'Installa TensorRT-LLM' })).toBeTruthy();
  });

  it('"Ricontrolla" says it is checking while it does; a problem without details is still said', async () => {
    const api = libApi(world({ engines: engines({}, installedNative({ available: false, problems: ['ENGINE_START_FAILED'], problemParams: undefined })) }));
    api.on('GET /api/setup/check', (_b, q) => (q.get('fresh') === '1' ? new Promise(() => undefined) : api.w.check));
    renderLib('/engines', api);
    const c = await card();
    await pick(c, /In WSL/);
    expect(within(c).getAllByRole('note').length).toBeGreaterThan(1);
    await userEvent.click(within(c).getByRole('button', { name: 'Ricontrolla' }));
    expect(await within(c).findByRole('button', { name: 'Controllo…' })).toBeTruthy();
  });

  it('installed but a system library is missing: said with its fix, the card warns; "Usa questo"', async () => {
    const broken = installedNative({ available: false, problems: ['ENGINE_MISSING_LIBRARY'], problemParams: { library: 'libmpi.so.40', package: 'libopenmpi-dev', distro: 'Ubuntu-24.04' }, version: undefined, location: undefined });
    const api = libApi(world({ engines: engines({}, broken) }));
    renderLib('/engines', api);
    const c = await card();
    await status(c, 'Manca qualcosa');
    await pick(c, /In WSL/);
    expect(within(c).getAllByText('TensorRT-LLM').length).toBeGreaterThan(1);
    expect(within(c).getAllByRole('note').length).toBeGreaterThan(1);
    expect(within(c).getByRole('button', { name: 'Ricontrolla' })).toBeTruthy();
    await userEvent.click(within(c).getByRole('button', { name: 'Usa questo' }));
    await waitFor(() => expect(calls(api, 'PUT', '/api/settings')[0]?.body).toEqual({ lastEngine: { kind: 'trtllm-native' } }));
  });

  it('a refused removal and a failed choice are explained', async () => {
    const api = libApi(world({ system: linux, engines: engines({}, installedNative({ variant: undefined, location: '/opt/trtllm/bin/python' })) }));
    api.on('DELETE /api/engines/trtllm-native/install', () => fail('VALIDATION', 400));
    api.on('PUT /api/settings', () => fail('INTERNAL', 500));
    renderLib('/engines', api);
    const c = await card();
    await pick(c, /Sul PC/);
    expect(within(c).getByText('/opt/trtllm/bin/python')).toBeTruthy();
    await userEvent.click(within(c).getByRole('button', { name: 'Usa questo' }));
    await userEvent.click(within(c).getByRole('button', { name: 'Rimuovi TensorRT-LLM 1.2.0' }));
    await userEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Rimuovi' }));
    await waitFor(() => expect(within(c).getAllByRole('note').length).toBeGreaterThanOrEqual(3));
  });

  it('macOS: native is not there; the switch says so', async () => {
    renderLib('/engines', libApi(world({ system: system({ os: { platform: 'darwin', release: '24', arch: 'arm64', name: 'macOS', isWsl: false } }), engines: engines({}, { supported: false }) })));
    const c = await card();
    expect(await within(c).findByText('Non disponibile')).toBeTruthy();
    await pick(c, /Sul PC/);
    expect(within(c).getByText('Su questo sistema TensorRT-LLM gira solo in Docker.')).toBeTruthy();
  });

  it('while the statuses load, the card says so', async () => {
    const api = libApi();
    api.on('GET /api/engines', () => new Promise(() => undefined));
    renderLib('/engines', api);
    const c = await card();
    expect(within(c).getByText('Caricamento…')).toBeTruthy();
    await pick(c, /In WSL/);
    expect(within(c).queryByRole('button', { name: 'Installa TensorRT-LLM' })).toBeNull();
  });
});

describe('TensorRT-LLM card logic', () => {
  it('RTX 50 cards (sm_120) are experimental; the others are not flagged', () => {
    expect(isRtx50({ name: 'NVIDIA GeForce RTX 5080', computeCapability: '12.0' })).toBe(true);
    expect(isRtx50({ name: 'NVIDIA GeForce RTX 5070 Ti' })).toBe(true);
    expect(isRtx50({ name: 'NVIDIA GeForce RTX 4090', computeCapability: '8.9' })).toBe(false);
    expect(isRtx50(undefined)).toBe(false);
  });

  const tags = world().trtllmTags;
  it('the versions: NGC’s, what is on the PC by tag or digest, the ones NGC no longer lists, the status’s own', () => {
    const v = trtllmVersions(TRTLLM_REPO, tags, [image({ id: 'x', tags: [], digests: ['sha256:120'] }), image({ tags: [] })], undefined);
    expect(v.map((x) => [x.tag, !!x.local])).toEqual([
      ['1.3.0rc2', false],
      ['1.2.0', true],
      ['1.1.0', false],
    ]);
    expect(trtllmVersions(TRTLLM_REPO, tags, undefined, dockerStatus({ installed: true }))[1]?.local).toEqual({ running: false });
    expect(trtllmVersions(TRTLLM_REPO, [], undefined, dockerStatus({ installed: true, version: undefined, location: 'x:y' }))).toEqual([{ tag: 'x:y', image: 'x:y', recommended: false, prerelease: false, local: { running: false } }]);
    expect(trtllmVersions(TRTLLM_REPO, [], undefined, undefined)).toEqual([]);
  });

  it('each way’s state', () => {
    const local: TrtllmVersion[] = [{ tag: '1', image: 'i', recommended: true, prerelease: false, local: { running: false } }];
    expect(dockerModeState(local, 'stopped')).toBe('needsDocker');
    expect(dockerModeState([], 'running')).toBe('notInstalled');
    expect(dockerModeState(local, 'running')).toBe('ready');
    expect(nativeModeState(undefined)).toBe('unsupported');
    expect(nativeModeState(nativeStatus({ supported: false }))).toBe('unsupported');
    expect(nativeModeState(nativeStatus({ problemParams: { reason: 'wsl_missing' } }))).toBe('needsSetup');
    expect(nativeModeState(nativeStatus())).toBe('notInstalled');
    expect(nativeModeState(installedNative())).toBe('ready');
    expect(nativeModeState(installedNative({ available: false }))).toBe('needsSetup');
    expect(nativeNeed(nativeStatus({ problemParams: { reason: 'distro_missing' } }))).toBe('distro');
    expect(nativeNeed(nativeStatus({ problems: ['ENGINE_START_FAILED'] }))).toBeUndefined();
    expect(nativeNeed(nativeStatus({ problemParams: undefined }))).toBeUndefined();
    expect(nativeNeed(undefined)).toBeUndefined();
  });

  it('the card’s status: ready, what holds back what is on the PC, else not installed', () => {
    expect(trtllmStatus(false, false, 'ready', 'notInstalled')).toEqual({ tone: 'success', key: 'ready' });
    expect(trtllmStatus(false, false, 'needsDocker', 'ready').key).toBe('ready');
    expect(trtllmStatus(true, false, 'needsDocker', 'notInstalled')).toEqual({ tone: 'warning', key: 'needsDocker' });
    expect(trtllmStatus(false, true, 'notInstalled', 'needsSetup')).toEqual({ tone: 'warning', key: 'needsSetup' });
    expect(trtllmStatus(false, false, 'needsDocker', 'needsSetup')).toEqual({ tone: 'neutral', key: 'notInstalled' });
  });

  it('the way shown first, the image in use, the first download, the order', () => {
    expect(initialMode({ kind: 'trtllm-native' }, 'ready', 'ready')).toBe('native');
    expect(initialMode({ kind: 'trtllm-docker' }, 'notInstalled', 'ready')).toBe('docker');
    expect(initialMode({ kind: 'trtllm-native', customEngineId: 'x' }, 'notInstalled', 'notInstalled')).toBe('docker');
    expect(initialMode(undefined, 'notInstalled', 'ready')).toBe('native');
    expect(initialMode({ kind: 'vllm-docker' }, 'ready', 'ready')).toBe('docker');
    expect(imageInUse({ kind: 'trtllm-docker', image: 'a' }, 'b')).toBe('a');
    expect(imageInUse({ kind: 'trtllm-docker' }, 'b')).toBe('b');
    expect(imageInUse({ kind: 'trtllm-docker', image: 'a', customEngineId: 'x' }, 'b')).toBe('b');
    expect(imageInUse(undefined, undefined)).toBeUndefined();
    const v = trtllmVersions(TRTLLM_REPO, tags, [image({ tags: ['1.1.0'] })], undefined);
    expect(firstVersion(v)?.tag).toBe('1.2.0');
    expect(firstVersion(v.map((x) => ({ ...x, recommended: false })))?.tag).toBe('1.2.0');
    expect(firstVersion([{ tag: 'rc', image: 'i', recommended: false, prerelease: true }])?.tag).toBe('rc');
    expect(firstVersion([])).toBeUndefined();
    expect(sortVersions(v).map((x) => x.tag)).toEqual(['1.1.0', '1.3.0rc2', '1.2.0']);
  });
});
