/** "Docker non risponde" on every page, the restart with its last resort, our servers Docker took down. */
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { toast } from 'sonner';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { renderApp } from '../helpers';
import { apiError, benchApi } from '../bench/world';

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

const posted = (api: ReturnType<typeof benchApi>, path: string) => api.calls.filter((c) => c.method === 'POST' && c.path === path);

/** The real stuck case: Resource Saver stopped the engine and the stop never finished. */
const RESOURCE_SAVER = {
  cause: 'resource-saver' as const,
  since: '2026-10-09T19:24:55.162Z',
  evidence: ['2026-10-09 19:24:55 UTC · stopping VM', '2026-10-09 19:24:55 UTC · setting engine linux/wsl state running -> stopping'],
  resourceSaver: { enabled: true, timeoutSeconds: 300 },
};

describe('Docker that does not answer: the banner', () => {
  it('says it on every page, with why it happened and how to avoid it (Resource Saver, Docker Desktop opened, never changed)', async () => {
    const api = benchApi();
    api.world.docker = { state: 'not-responding', reason: 'desktop-stuck' };
    api.world.diagnosis = RESOURCE_SAVER;
    const ok = vi.spyOn(toast, 'success');
    renderApp('/results', api);
    const banner = await screen.findByRole('alert');
    expect(within(banner).getByText('Docker non risponde')).toBeTruthy();
    expect(within(banner).getByText('I server e i test che usano Docker non funzionano finché non lo riavvii.')).toBeTruthy();
    await userEvent.click(within(banner).getByRole('button', { name: 'Perché e come evitarlo' }));
    const dialog = await screen.findByRole('dialog', { name: 'Docker non risponde' });
    expect(within(dialog).getByText(/si spegne da solo dopo 5 minuti senza contenitori accesi/)).toBeTruthy();
    expect(within(dialog).getByText(/Resources → Advanced → Resource Saver/)).toBeTruthy();
    expect(within(dialog).getByText('2026-10-09 19:24:55 UTC · stopping VM')).toBeTruthy();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Apri Docker Desktop' }));
    await waitFor(() => expect(posted(api, '/api/docker/open')).toHaveLength(1));
    expect(ok).toHaveBeenCalledWith('Docker Desktop è aperto: cerca l’ingranaggio in alto a destra.');
    // The window could not be opened: the error in words.
    const bad = vi.spyOn(toast, 'error');
    api.world.routes['POST /api/docker/open'] = () => {
      throw apiError('DOCKER_NOT_INSTALLED');
    };
    await userEvent.click(within(dialog).getByRole('button', { name: 'Apri Docker Desktop' }));
    await waitFor(() => expect(bad).toHaveBeenCalledWith('Docker non è installato'));
  });

  it('"Riavvia Docker": the steps, then the last resort explained when a normal restart is not enough, then Docker back', async () => {
    const api = benchApi();
    api.world.docker = { state: 'not-responding', reason: 'desktop-stuck' };
    renderApp('/results', api);
    const banner = await screen.findByRole('alert');
    await userEvent.click(within(banner).getByRole('button', { name: 'Riavvia Docker' }));
    await waitFor(() => expect(posted(api, '/api/docker/restart')).toEqual([{ method: 'POST', path: '/api/docker/restart', body: { deep: false } }]));
    act(() => api.emit({ type: 'engine.install', kind: 'docker-restart', stage: 'force-stop', step: 2, steps: 3, bytesDone: 95_000, state: 'starting', slow: true }));
    const dialog = await screen.findByRole('dialog', { name: 'Riavvio Docker…' });
    expect(within(dialog).getByText('Chiusura forzata di Docker Desktop')).toBeTruthy();
    expect(within(dialog).getByText('Passo 2 di 3')).toBeTruthy();
    expect(within(dialog).getByText('da 1 min 35 s')).toBeTruthy();
    expect(within(dialog).getByText(/Ci sta mettendo più del solito/)).toBeTruthy();
    // The banner shows the same progress behind the dialog.
    expect(screen.getAllByText('Chiusura forzata di Docker Desktop')).toHaveLength(2);
    act(() => api.emit({ type: 'engine.install', kind: 'docker-restart', stage: 'error', bytesDone: 0, error: { code: 'DOCKER_NOT_RESPONDING', message: 'x', params: { reason: 'needs-deep' } } }));
    const deep = await screen.findByRole('dialog', { name: 'Il riavvio normale non è bastato' });
    expect(within(deep).getByText(/le tue altre distribuzioni WSL \(per esempio Ubuntu\) restano accese/)).toBeTruthy();
    expect(within(deep).getByRole('region', { name: 'Comando che eseguo' }).textContent).toContain('wsl --terminate docker-desktop');
    await userEvent.click(within(deep).getByRole('button', { name: 'Spegni e riaccendi la macchina di Docker' }));
    await waitFor(() => expect(posted(api, '/api/docker/restart').at(-1)?.body).toEqual({ deep: true }));
    act(() => api.emit({ type: 'engine.install', kind: 'docker-restart', stage: 'wsl-terminate', step: 2, steps: 3, bytesDone: 0 }));
    expect((await screen.findAllByText('Spegnimento della macchina WSL di Docker')).length).toBeGreaterThan(0);
    api.world.docker = { state: 'running' };
    act(() => api.emit({ type: 'engine.install', kind: 'docker-restart', stage: 'running', bytesDone: 0, state: 'running', result: { restored: [], failed: [] } }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    act(() => api.emit({ type: 'docker.changed', state: 'running' }));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  });

  it('a restart that failed for good, or a Docker Desktop too old to be restarted from here: what to do by hand', async () => {
    for (const [reason, text] of [
      ['restart-failed', /riavvia il PC/],
      ['no-desktop-cli', /non si lascia riavviare da qui/],
    ] as const) {
      const api = benchApi();
      api.world.docker = { state: 'not-responding', reason: 'calls-failing' };
      const view = renderApp('/results', api);
      await userEvent.click(within(await screen.findByRole('alert')).getByRole('button', { name: 'Riavvia Docker' }));
      act(() => api.emit({ type: 'engine.install', kind: 'docker-restart', stage: 'error', bytesDone: 0, error: { code: 'DOCKER_NOT_RESPONDING', message: 'x', params: { reason } } }));
      const dialog = await screen.findByRole('dialog', { name: 'Non sono riuscito a riavviare Docker' });
      expect(within(dialog).getByText(text)).toBeTruthy();
      await userEvent.click(within(dialog).getByRole('button', { name: 'Riprova' }));
      view.unmount();
    }
  });

  it('a restart asked from the tray: its progress in the banner, the servers it starts again too', async () => {
    const api = benchApi();
    renderApp('/results', api);
    await screen.findByRole('heading', { level: 1 });
    act(() => api.emit({ type: 'engine.install', kind: 'docker-restart', stage: 'restart', step: 1, steps: 4, bytesDone: 0 }));
    expect(await screen.findByText('Riavvio di Docker Desktop')).toBeTruthy();
    act(() => api.emit({ type: 'engine.install', kind: 'docker-restart', stage: 'servers', step: 4, steps: 4, bytesDone: 0, bytesTotal: 2, label: 'Chat veloce' }));
    expect(await screen.findByText('Riaccendo i server…')).toBeTruthy();
    expect(screen.getByText('Riaccensione dei server che erano attivi · Chat veloce (1/2)')).toBeTruthy();
    // A step this version does not know reads as a restart.
    act(() => api.emit({ type: 'engine.install', kind: 'docker-restart', stage: 'starting', bytesDone: 0 }));
    expect(await screen.findByText('Riavvio di Docker Desktop')).toBeTruthy();
  });

  it('Linux: no button to restart a system service; the details give the command', async () => {
    const api = benchApi();
    api.world.system = { ...api.world.system, os: { ...api.world.system.os, platform: 'linux' } };
    api.world.docker = { state: 'not-responding', reason: 'version-timeout' };
    renderApp('/results', api);
    const banner = await screen.findByRole('alert');
    await waitFor(() => expect(within(banner).queryByRole('button', { name: 'Riavvia Docker' })).toBeNull());
    await userEvent.click(within(banner).getByRole('button', { name: 'Perché e come evitarlo' }));
    const dialog = await screen.findByRole('dialog', { name: 'Docker non risponde' });
    expect(within(dialog).getByText(/riavvialo con questo comando/)).toBeTruthy();
    expect(within(dialog).getByRole('region', { name: 'Docker non risponde' }).textContent).toContain('sudo systemctl restart docker');
  });
});

describe('servers Docker took down', () => {
  it('one: "Riavvia il server"; several: "Riavvia i server che erano attivi"; "Non ora" forgets them', async () => {
    const api = benchApi();
    api.world.recovery = { servers: [{ id: 's1', name: 'Chat veloce', port: 8080, presetId: 'p1' }], restoring: false };
    const view = renderApp('/results', api);
    expect(await screen.findByText('Docker si è fermato e ha spento «Chat veloce»')).toBeTruthy();
    expect(screen.getByText(/Posso riaccenderlo con le stesse impostazioni/)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Riavvia il server' }));
    await waitFor(() => expect(posted(api, '/api/docker/recovery')).toHaveLength(1));
    view.unmount();

    const many = benchApi();
    many.world.recovery = {
      servers: [
        { id: 's1', name: 'Chat veloce', port: 8080 },
        { id: 's2', name: 'Codice', port: 8090 },
      ],
      restoring: false,
    };
    renderApp('/results', many);
    expect(await screen.findByText('Docker si è fermato e ha spento 2 server')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Riavvia i server che erano attivi' })).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Non ora' }));
    await waitFor(() => expect(many.calls.some((c) => c.method === 'DELETE' && c.path === '/api/docker/recovery')).toBe(true));
    await waitFor(() => expect(screen.queryByText('Docker si è fermato e ha spento 2 server')).toBeNull());
  });

  it('while they start again it says so; nothing is offered while Docker is not back', async () => {
    const api = benchApi();
    api.world.recovery = { servers: [{ id: 's1', name: 'Chat veloce', port: 8080 }], restoring: true };
    const view = renderApp('/results', api);
    expect(await screen.findByText('Riaccendo i server…')).toBeTruthy();
    view.unmount();
    const down = benchApi();
    down.world.docker = { state: 'stopped' };
    down.world.recovery = { servers: [{ id: 's1', name: 'Chat veloce', port: 8080 }], restoring: false };
    renderApp('/results', down);
    await screen.findByRole('heading', { level: 1 });
    await waitFor(() => expect(down.calls.some((c) => c.path === '/api/docker/recovery')).toBe(true));
    expect(screen.queryByText('Docker si è fermato e ha spento «Chat veloce»')).toBeNull();
  });
});
