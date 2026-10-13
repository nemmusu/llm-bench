/** "Serve Docker" in the start flow and on the Server page: off, starting, stuck, Linux, other states; then the start carries on by itself. */
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { toast } from 'sonner';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { renderApp } from '../helpers';
import type { DockerStatusDetail } from '../../../../src/contract/views';
import { apiError, benchApi, serverInfo, serverPreset } from '../bench/world';

vi.mock('echarts/core', () => ({ use: vi.fn(), init: vi.fn(() => ({ setOption: vi.fn(), resize: vi.fn(), dispose: vi.fn() })) }));
vi.mock('echarts/charts', () => ({ LineChart: {}, BarChart: {} }));
vi.mock('echarts/components', () => ({ AxisPointerComponent: {}, DataZoomComponent: {}, GridComponent: {}, LegendComponent: {}, MarkAreaComponent: {}, MarkLineComponent: {}, TooltipComponent: {} }));
vi.mock('echarts/renderers', () => ({ CanvasRenderer: {} }));

beforeAll(() => {
  Object.assign(Element.prototype, { hasPointerCapture: () => false, releasePointerCapture: () => undefined, scrollIntoView: () => undefined });
});
afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

type Api = ReturnType<typeof benchApi>;
const posted = (api: Api, path: string) => api.calls.filter((c) => c.method === 'POST' && c.path === path);
const h1 = (name: string | RegExp) => screen.findByRole('heading', { level: 1, name });

/** The Benchmark page with vLLM (Docker) and the library's safetensors model, Docker as given. */
function vllmBench(docker: Api['world']['docker']) {
  const api = benchApi();
  api.settings.lastEngine = { kind: 'vllm-docker' };
  api.settings.lastModelId = 'st';
  api.world.docker = docker;
  return api;
}

async function startBenchmark(api: Api) {
  renderApp('/', api);
  await screen.findAllByText('≈ 1 min 35 s');
  await userEvent.click(screen.getByRole('button', { name: 'Avvia benchmark' }));
}

describe('the start flow with a Docker engine', () => {
  it('Docker running: no question, the test starts', async () => {
    const api = vllmBench({ state: 'running' });
    await startBenchmark(api);
    expect(await h1('Test in corso')).toBeTruthy();
    expect(api.calls.some((c) => c.path === '/api/docker/status?probe=1')).toBe(true);
  });

  it('stuck: what happened and "Riavvia Docker"; once Docker is back the test starts by itself', async () => {
    const api = vllmBench({ state: 'not-responding', reason: 'desktop-stuck' });
    api.world.diagnosis = { cause: 'resource-saver', since: '2026-10-09T19:24:55.162Z', evidence: [], resourceSaver: { enabled: true, timeoutSeconds: 300 } };
    await startBenchmark(api);
    const dialog = await screen.findByRole('dialog', { name: 'Docker non risponde' });
    expect(within(dialog).getByText(/si blocca mentre si spegne o si riaccende/)).toBeTruthy();
    expect(await within(dialog).findByText('Perché è successo')).toBeTruthy();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Riavvia Docker' }));
    expect(posted(api, '/api/docker/restart')).toHaveLength(1);
    expect(await screen.findByRole('dialog', { name: 'Riavvio Docker…' })).toBeTruthy();
    api.world.docker = { state: 'running' };
    act(() => api.emit({ type: 'engine.install', kind: 'docker-restart', stage: 'running', bytesDone: 0, state: 'running', result: { restored: [], failed: [] } }));
    expect(await h1('Test in corso')).toBeTruthy();
  });

  it('starting (asked elsewhere): it waits, then carries on', async () => {
    const api = vllmBench({ state: 'starting', startingForMs: 40_000 });
    await startBenchmark(api);
    const dialog = await screen.findByRole('dialog', { name: 'Avvio Docker…' });
    expect(within(dialog).getByText(/^da 40/)).toBeTruthy();
    api.world.docker = { state: 'running' };
    act(() => api.emit({ type: 'docker.changed', state: 'running' }));
    expect(await h1('Test in corso')).toBeTruthy();
  });

  it('a start that fails says why (and can be tried again); one that leaves Docker stuck offers the restart', async () => {
    const api = vllmBench({ state: 'stopped' });
    await startBenchmark(api);
    let dialog = await screen.findByRole('dialog', { name: 'Docker è spento' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Avvia Docker' }));
    act(() => api.emit({ type: 'engine.install', kind: 'docker-desktop', stage: 'starting', bytesDone: 70_000, state: 'starting', slow: true }));
    dialog = await screen.findByRole('dialog', { name: 'Avvio Docker…' });
    expect(within(dialog).getByText(/^da 1 min 10/)).toBeTruthy();
    expect(within(dialog).getByText(/Ci sta mettendo più del solito/)).toBeTruthy();
    act(() => api.emit({ type: 'engine.install', kind: 'docker-desktop', stage: 'error', bytesDone: 0, error: { code: 'DOCKER_NOT_RUNNING', message: 'x', params: { reason: 'start-timeout' } } }));
    api.world.docker = { state: 'stopped' };
    dialog = await screen.findByRole('dialog', { name: 'Docker non è avviato' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Riprova' }));
    dialog = await screen.findByRole('dialog', { name: 'Docker è spento' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Avvia Docker' }));
    api.world.docker = { state: 'not-responding', reason: 'start-timeout' };
    act(() => api.emit({ type: 'engine.install', kind: 'docker-desktop', stage: 'error', bytesDone: 0, error: { code: 'DOCKER_NOT_RESPONDING', message: 'x', params: { reason: 'start-timeout' } } }));
    expect(await screen.findByRole('dialog', { name: 'Docker non risponde' })).toBeTruthy();
    // "Annulla" leaves it there.
    await userEvent.click(screen.getByRole('button', { name: 'Annulla' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('not installed (or another state no button here fixes): said, with the way to the Engines page', async () => {
    const api = vllmBench({ state: 'not-installed' });
    renderApp('/', api);
    await screen.findAllByText('≈ 1 min 35 s');
    await userEvent.click(screen.getByRole('button', { name: 'Avvia benchmark' }));
    const dialog = await screen.findByRole('dialog', { name: 'Docker non è pronto' });
    expect(within(dialog).getByText('Docker non è installato')).toBeTruthy();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Riprova' }));
    await userEvent.click(within(await screen.findByRole('dialog', { name: 'Docker non è pronto' })).getByRole('button', { name: 'Apri Motori' }));
    expect(await h1('Motori')).toBeTruthy();
  });

  it('Linux: the command to start the service, then "Riprova"', async () => {
    const api = vllmBench({ state: 'stopped' });
    api.world.system = { ...api.world.system, os: { ...api.world.system.os, platform: 'linux' } };
    await startBenchmark(api);
    const dialog = await screen.findByRole('dialog', { name: 'Docker è spento' });
    expect(within(dialog).getByText(/Su Linux Docker è un servizio del sistema/)).toBeTruthy();
    expect(within(dialog).getByRole('region', { name: 'Docker è spento' }).textContent).toContain('sudo systemctl start docker');
    api.world.docker = { state: 'running' };
    await userEvent.click(within(dialog).getByRole('button', { name: 'Riprova' }));
    expect(await h1('Test in corso')).toBeTruthy();
  });

  it('Docker failing later (the container itself): "Serve Docker", even when its check fails, then the start again', async () => {
    const api = vllmBench({ state: 'running' });
    let fail = true;
    api.world.routes['POST /api/runs'] = () => {
      if (fail) {
        fail = false;
        // The engine stopped answering at the very moment: the check fails too.
        api.world.routes['GET /api/docker/status?probe=1'] = () => {
          throw apiError('INTERNAL');
        };
        throw apiError('DOCKER_NOT_RESPONDING', { reason: 'deadline' });
      }
      api.world.active = { runId: '01M48PNN41KKD0ABVXTGK97Y6P' } as never;
      return { runId: '01M48PNN41KKD0ABVXTGK97Y6P' };
    };
    await startBenchmark(api);
    const dialog = await screen.findByRole('dialog', { name: 'Si è verificato un errore imprevisto' });
    delete api.world.routes['GET /api/docker/status?probe=1'];
    await userEvent.click(within(dialog).getByRole('button', { name: 'Riprova' }));
    await waitFor(() => expect(posted(api, '/api/runs')).toHaveLength(2));
  });

  it('a Docker check that fails lets the start go on (the start says what is wrong); closing while it looks drops the start', async () => {
    const api = vllmBench({ state: 'running' });
    api.world.routes['GET /api/docker/status?probe=1'] = () => {
      throw apiError('INTERNAL');
    };
    const view = renderApp('/', api);
    await screen.findAllByText('≈ 1 min 35 s');
    await userEvent.click(screen.getByRole('button', { name: 'Avvia benchmark' }));
    expect(await h1('Test in corso')).toBeTruthy();
    view.unmount();

    const slow = vllmBench({ state: 'stopped' });
    let release!: (s: DockerStatusDetail) => void;
    slow.world.routes['GET /api/docker/status?probe=1'] = () => new Promise<DockerStatusDetail>((r) => (release = r));
    await startBenchmark(slow);
    await screen.findByRole('dialog');
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    act(() => release({ state: 'stopped' }));
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('a server from the Server page waits for Docker the same way', async () => {
    const api = benchApi();
    api.world.docker = { state: 'stopped' };
    renderApp('/servers/new', api);
    await screen.findByRole('heading', { level: 1, name: 'Avvia un server' });
    await screen.findByRole('region', { name: 'Comando esatto' });
    await userEvent.click(screen.getByRole('button', { name: /Cambia modello/ }));
    const picker = await screen.findByRole('dialog', { name: 'Scegli un modello' });
    await userEvent.click(within(picker).getByRole('radio', { name: /^st model/ }));
    await userEvent.click(within(picker).getByRole('button', { name: 'Conferma' }));
    await waitFor(() => expect(posted(api, '/api/servers/plan').at(-1)?.body).toMatchObject({ engine: { kind: 'vllm-docker' } }));
    fireEvent.click(screen.getByRole('button', { name: /^(Avvia|Scarica e avvia)$/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Docker è spento' });
    expect(within(dialog).getByText(/vLLM \(Docker\).* gira dentro Docker/)).toBeTruthy();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Avvia Docker' }));
    api.world.docker = { state: 'running' };
    act(() => api.emit({ type: 'engine.install', kind: 'docker-desktop', stage: 'running', bytesDone: 0, state: 'running' }));
    await waitFor(() => expect(posted(api, '/api/servers')).toHaveLength(1));
  });
});

describe('the Server page: presets and restarts that meet Docker off or stuck', () => {
  it('a preset that needs Docker: "Serve Docker", then the preset starts by itself', async () => {
    const api = benchApi();
    api.world.presets = [serverPreset('p1', { name: 'Chat vLLM', engine: { kind: 'vllm-docker' }, modelLabel: 'Qwen3 8B' })];
    api.world.docker = { state: 'stopped' };
    let first = true;
    api.world.routes['POST /api/servers/presets/p1/start'] = () => {
      if (first) {
        first = false;
        throw apiError('DOCKER_NOT_RUNNING', { reason: 'stopped' });
      }
      return serverInfo('s9');
    };
    renderApp('/servers', api);
    await userEvent.click(await screen.findByRole('button', { name: 'Avvia il preset Chat vLLM' }));
    const dialog = await screen.findByRole('dialog', { name: 'Docker è spento' });
    expect(within(dialog).getByText(/Qwen3 8B gira dentro Docker/)).toBeTruthy();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Avvia Docker' }));
    api.world.docker = { state: 'running' };
    act(() => api.emit({ type: 'engine.install', kind: 'docker-desktop', stage: 'running', bytesDone: 0, state: 'running' }));
    await waitFor(() => expect(posted(api, '/api/servers/presets/p1/start')).toHaveLength(2));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('"Riavvia" of a server whose Docker got stuck: once Docker answers, the same server again; closing the dialog drops it', async () => {
    const api = benchApi();
    api.world.servers = [serverInfo('s1', { port: 8080, engineKind: 'vllm-docker', engineLabel: 'vLLM v0.12' })];
    api.world.routes['POST /api/servers/s1/restart'] = () => {
      throw apiError('DOCKER_NOT_RESPONDING', { reason: 'deadline' });
    };
    api.world.docker = { state: 'running' };
    const ok = vi.spyOn(toast, 'success');
    renderApp('/servers', api);
    const card = await screen.findByRole('region', { name: 'Server Qwen3 8B sulla porta 8080' });
    await userEvent.click(within(card).getByRole('button', { name: 'Riavvia il server Qwen3 8B' }));
    // Docker answers again by the time the dialog looks: the server starts again at once.
    await waitFor(() => expect(posted(api, '/api/servers')).toHaveLength(1));
    expect(posted(api, '/api/servers')[0]!.body).toEqual(api.world.servers[0]!.request);
    await waitFor(() => expect(ok).toHaveBeenCalledWith('Qwen3 8B è di nuovo pronto'));
    // The new engine does not start either: said in a toast.
    api.world.routes['POST /api/servers'] = () => {
      throw apiError('ENGINE_START_FAILED');
    };
    const bad = vi.spyOn(toast, 'error');
    const again = (await screen.findAllByRole('region', { name: 'Server Qwen3 8B sulla porta 8080' }))[0]!;
    await userEvent.click(within(again).getByRole('button', { name: 'Riavvia il server Qwen3 8B' }));
    await waitFor(() => expect(bad).toHaveBeenCalledWith('Il motore non è partito'));
    // Again, now with Docker stuck: the dialog can be closed (nothing restarts).
    api.world.docker = { state: 'not-responding' };
    const card2 = (await screen.findAllByRole('region', { name: 'Server Qwen3 8B sulla porta 8080' }))[0]!;
    await userEvent.click(within(card2).getByRole('button', { name: 'Riavvia il server Qwen3 8B' }));
    const dialog = await screen.findByRole('dialog', { name: 'Docker non risponde' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Chiudi' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});
