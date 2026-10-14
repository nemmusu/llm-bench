/** Engines → Docker when it does not answer, "Riavvia Docker" while it runs; the system check's fix; the model search's note. */
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { item, libApi, okItems, renderLib, report, system, world } from './fake';

vi.mock('echarts/core', () => ({ use: vi.fn(), init: vi.fn(() => ({ setOption: vi.fn(), resize: vi.fn(), dispose: vi.fn() })) }));
vi.mock('echarts/charts', () => ({ LineChart: {}, BarChart: {} }));
vi.mock('echarts/components', () => ({ AxisPointerComponent: {}, DataZoomComponent: {}, GridComponent: {}, LegendComponent: {}, MarkAreaComponent: {}, MarkLineComponent: {}, TooltipComponent: {} }));
vi.mock('echarts/renderers', () => ({ CanvasRenderer: {} }));

afterEach(() => {
  vi.restoreAllMocks();
});

const card = (title: string) => screen.findByRole('region', { name: title });
const linux = system({ os: { platform: 'linux', release: '6', arch: 'x64', name: 'Ubuntu 24.04', isWsl: false } });
const posts = (api: ReturnType<typeof libApi>, path: string) => api.calls.filter((c) => c.method === 'POST' && c.path === path);

describe('Engines → Docker', () => {
  it('not responding: said in red, why and how to avoid it, "Riavvia Docker" in its dialog', async () => {
    const api = libApi(world({ docker: { state: 'not-responding', reason: 'desktop-stuck' } }));
    renderLib('/engines', api);
    const docker = await card('Docker');
    expect(await within(docker).findByText('Non risponde')).toBeTruthy();
    expect(within(docker).getByText(/Docker Desktop è aperto ma non risponde più/)).toBeTruthy();
    expect(await within(docker).findByText('Per evitarlo la prossima volta')).toBeTruthy();
    await userEvent.click(within(docker).getByRole('button', { name: 'Riavvia Docker' }));
    const dialog = await screen.findByRole('dialog', { name: /Docker/ });
    await waitFor(() => expect(posts(api, '/api/docker/restart')).toHaveLength(1));
    act(() => api.emit({ type: 'engine.install', kind: 'docker-restart', stage: 'start', step: 3, steps: 3, bytesDone: 30_000 }));
    expect(await within(dialog).findByText('Accensione di Docker Desktop')).toBeTruthy();
    expect(within(docker).getByText('Accensione di Docker Desktop')).toBeTruthy();
    api.w.docker = { state: 'running', version: '29.8.0' };
    act(() => api.emit({ type: 'engine.install', kind: 'docker-restart', stage: 'running', bytesDone: 0, state: 'running' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(await within(docker).findByText('Acceso')).toBeTruthy();
  });

  it('running: "Riavvia Docker" at once (no dialog); a failed restart is explained in the card', async () => {
    const api = libApi();
    renderLib('/engines', api);
    const docker = await card('Docker');
    await userEvent.click(await within(docker).findByRole('button', { name: 'Riavvia Docker' }));
    expect(posts(api, '/api/docker/restart')[0]?.body).toEqual({ deep: false });
    act(() => api.emit({ type: 'engine.install', kind: 'docker-restart', stage: 'error', bytesDone: 0, error: { code: 'DOCKER_NOT_INSTALLED', message: 'gone' } }));
    expect(await within(docker).findByText('Docker non è installato')).toBeTruthy();
    act(() => api.emit({ type: 'engine.install', kind: 'docker-restart', stage: 'error', bytesDone: 0 }));
    expect(await within(docker).findByText('Docker non risponde')).toBeTruthy();
  });

  it('Linux, Docker off: no "Avvia Docker" (a system service); "Come avviarlo" gives the command, then it carries on', async () => {
    const api = libApi(world({ system: linux, docker: { state: 'stopped' } }));
    renderLib('/engines', api);
    const docker = await card('Docker');
    expect(await within(docker).findByText(/Su Linux è un servizio del sistema: premi «Come avviarlo»/)).toBeTruthy();
    expect(within(docker).queryByRole('button', { name: 'Avvia Docker' })).toBeNull();
    await userEvent.click(within(docker).getByRole('button', { name: 'Come avviarlo' }));
    const dialog = await screen.findByRole('dialog', { name: 'Docker è spento' });
    expect((await within(dialog).findByRole('region', { name: 'Docker è spento' })).textContent).toBe('sudo systemctl start docker');
    // The user runs it: the dialog sees Docker answer and closes by itself.
    api.w.docker = { state: 'running', version: '29.8.0' };
    await userEvent.click(within(dialog).getByRole('button', { name: 'Riprova' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(posts(api, '/api/docker/start')).toEqual([]);
  });

  it('Linux: no restart from here; the dialog gives the command', async () => {
    const api = libApi(world({ system: linux, docker: { state: 'not-responding', reason: 'version-timeout' } }));
    renderLib('/engines', api);
    const docker = await card('Docker');
    expect(await within(docker).findByText(/Su Linux è un servizio del sistema: premi «Perché e come evitarlo»/)).toBeTruthy();
    await userEvent.click(await within(docker).findByRole('button', { name: 'Perché e come evitarlo' }));
    const dialog = await screen.findByRole('dialog', { name: 'Docker non risponde' });
    expect(within(dialog).getByText(/riavvialo con questo comando/)).toBeTruthy();
    expect(posts(api, '/api/docker/restart')).toEqual([]);
    const running = libApi(world({ system: linux }));
    renderLib('/engines', running);
    const card2 = (await screen.findAllByRole('region', { name: 'Docker' })).at(-1)!;
    await within(card2).findByText('Acceso');
    expect(within(card2).queryByRole('button', { name: 'Riavvia Docker' })).toBeNull();
  });
});

describe('system check: Docker that does not answer', () => {
  it('"Riavvia Docker" as its one-click fix, with the restart\'s progress', async () => {
    const api = libApi(
      world({
        docker: { state: 'not-responding' },
        check: report([...okItems().slice(0, 5), item('docker', { state: 'warning', code: 'DOCKER_NOT_RESPONDING', params: { dockerState: 'not-responding' }, action: { kind: 'restart-docker' } })]),
      }),
    );
    renderLib('/welcome', api);
    const row = (await screen.findByText('Docker è aperto ma non risponde: va riavviato.')).closest('li') as HTMLElement;
    await userEvent.click(within(row).getByRole('button', { name: 'Riavvia Docker (Docker)' }));
    act(() => api.emit({ type: 'engine.install', kind: 'docker-restart', stage: 'restart', step: 1, steps: 3, bytesDone: 0 }));
    expect(await within(row).findByRole('progressbar')).toBeTruthy();
    expect(posts(api, '/api/docker/restart')).toHaveLength(1);
  });
});

describe('model search: vLLM and SGLang need Docker', () => {
  it('Docker off: "Avvia Docker" next to the results, then its progress', async () => {
    const api = libApi(world({ docker: { state: 'stopped' } }));
    renderLib('/models?tab=download&engine=vllm', api);
    const note = await screen.findByText('vLLM e SGLang girano in Docker, che ora è spento: avvialo prima di provare questi modelli.');
    await userEvent.click(within(note.closest('[role="note"]') as HTMLElement).getByRole('button', { name: 'Avvia Docker' }));
    expect(posts(api, '/api/docker/start')).toHaveLength(1);
    act(() => api.emit({ type: 'engine.install', kind: 'docker-desktop', stage: 'starting', bytesDone: 5000, state: 'starting' }));
    expect(await screen.findByRole('progressbar', { name: 'Docker' })).toBeTruthy();
  });

  it('Docker stuck: "Riavvia Docker" in its dialog, and the restart\'s progress', async () => {
    const api = libApi(world({ docker: { state: 'not-responding' } }));
    renderLib('/models?tab=download&engine=sglang', api);
    const note = await screen.findByText('vLLM e SGLang girano in Docker, che ora non risponde: riavvialo prima di provare questi modelli.');
    await userEvent.click(within(note.closest('[role="note"]') as HTMLElement).getByRole('button', { name: 'Riavvia Docker' }));
    await screen.findByRole('dialog');
    await waitFor(() => expect(posts(api, '/api/docker/restart')).toHaveLength(1));
    act(() => api.emit({ type: 'engine.install', kind: 'docker-restart', stage: 'restart', step: 1, steps: 3, bytesDone: 0 }));
    expect((await screen.findAllByText('Riavvio di Docker Desktop')).length).toBeGreaterThan(0);
  });

  it('nothing to say with Docker running, on Linux when it is off, or for GGUF models', async () => {
    const api = libApi(world({ system: linux, docker: { state: 'stopped' } }));
    renderLib('/models?tab=download&engine=vllm', api);
    await screen.findByRole('heading', { level: 1 });
    await waitFor(() => expect(api.calls.some((c) => c.path === '/api/docker/status')).toBe(true));
    expect(screen.queryByText(/girano in Docker/)).toBeNull();
    const stuckLinux = libApi(world({ system: linux, docker: { state: 'not-responding' } }));
    renderLib('/models?tab=download&engine=vllm', stuckLinux);
    expect((await screen.findAllByRole('button', { name: 'Perché e come evitarlo' })).length).toBeGreaterThan(0);
  });
});
