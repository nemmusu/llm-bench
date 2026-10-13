/** The Docker gate on its own: every state it can show, with an API that answers only Docker's routes. */
import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DockerDiagnosis } from '../../../../src/contract/docker';
import type { DockerStatusDetail } from '../../../../src/contract/views';
import { DockerCause } from '../../../../src/renderer/components/docker/docker-cause';
import { DockerGateDialog, RestartProgress, useDockerGate } from '../../../../src/renderer/components/docker/docker-gate';
import type { ApiClient } from '../../../../src/renderer/lib/api';
import { fakeApi, renderUi } from '../helpers';

afterEach(() => vi.restoreAllMocks());

/** fakeApi plus GET /api/docker/status?probe=1 and /api/docker/diagnosis from the test; no /api/system (Windows assumed). */
function dockerApi(o: { probe: () => Promise<DockerStatusDetail> | DockerStatusDetail; diagnosis?: DockerDiagnosis }) {
  const api = fakeApi();
  const base = api.get;
  api.get = vi.fn(async <T,>(path: string) => {
    if (path === '/api/docker/status?probe=1') return (await o.probe()) as T;
    if (path === '/api/docker/diagnosis') return (o.diagnosis ?? { cause: 'unknown', evidence: [] }) as T;
    return base<T>(path);
  }) as ApiClient['get'];
  return api;
}

function Gate({ engineLabel, onReady = () => undefined }: { engineLabel?: string; onReady?: () => void }) {
  const gate = useDockerGate({ onReady, ...(engineLabel ? { engineLabel } : {}) });
  return (
    <section aria-label="gate">
      <h2>{gate.title}</h2>
      {gate.description && <p>{gate.description}</p>}
      {gate.body}
      {gate.actions}
    </section>
  );
}

describe('useDockerGate', () => {
  it('checking first; then what Docker says (no system info: Windows); ready once', async () => {
    let release!: (s: DockerStatusDetail) => void;
    const api = dockerApi({ probe: () => new Promise((r) => (release = r)) });
    const ready = vi.fn();
    renderUi(<Gate onReady={ready} />, { withSettings: true, api });
    expect(await screen.findByRole('heading', { name: 'Controllo Docker…' })).toBeTruthy();
    act(() => release({ state: 'running' }));
    expect(await screen.findByRole('heading', { name: 'Docker è pronto' })).toBeTruthy();
    expect(ready).toHaveBeenCalledTimes(1);
  });

  it('off, said plainly when it is Docker itself that is needed; a state of its own unknown: the way to the Engines page', async () => {
    renderUi(<Gate />, { withSettings: true, api: dockerApi({ probe: () => ({ state: 'stopped' }) }) });
    expect(await screen.findByText('Lo avvio io: di solito ci vuole un minuto.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Avvia Docker' })).toBeTruthy();
  });

  it('a state no button here fixes', async () => {
    renderUi(<Gate engineLabel="vLLM (Docker)" />, { withSettings: true, api: dockerApi({ probe: () => ({ state: 'unknown', detail: 'odd context' }) }) });
    expect(await screen.findByRole('heading', { name: 'Docker non è pronto' })).toBeTruthy();
    expect(screen.getByText('Docker non è avviato')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Apri Motori' })).toBeTruthy();
  });
});

describe('RestartProgress', () => {
  it('the servers step with or without a name', () => {
    renderUi(<RestartProgress event={{ type: 'engine.install', kind: 'docker-restart', stage: 'servers', bytesDone: 1, bytesTotal: 3 }} />);
    expect(screen.getByText('Riaccensione dei server che erano attivi (2/3)')).toBeTruthy();
  });
});

describe('DockerCause', () => {
  it('Resource Saver with Docker’s own default (5 minutes) when its settings could not be read', async () => {
    const api = dockerApi({ probe: () => ({ state: 'running' }), diagnosis: { cause: 'resource-saver', since: '2026-10-09T19:24:55.162Z', evidence: [] } });
    renderUi(<DockerCause windows />, { withSettings: true, api });
    expect(await screen.findByText(/dopo 5 minuti senza contenitori accesi/)).toBeTruthy();
    expect(screen.queryByText('Per evitarlo la prossima volta')).toBeNull();
    expect(screen.queryByText('Righe dal registro di Docker Desktop')).toBeNull();
  });

  it('not answering: said; nothing known and Resource Saver off: nothing at all', async () => {
    const api = dockerApi({ probe: () => ({ state: 'running' }), diagnosis: { cause: 'not-answering', evidence: [], resourceSaver: { enabled: false, timeoutSeconds: 300 } } });
    const view = renderUi(<DockerCause windows />, { withSettings: true, api });
    expect(await screen.findByText('Docker è acceso ma non risponde ai comandi.')).toBeTruthy();
    view.unmount();
    const quiet = dockerApi({ probe: () => ({ state: 'running' }), diagnosis: { cause: 'unknown', evidence: [], resourceSaver: { enabled: false, timeoutSeconds: 300 } } });
    const { container } = renderUi(<DockerCause windows />, { withSettings: true, api: quiet });
    await waitFor(() => expect(quiet.get).toHaveBeenCalledWith('/api/docker/diagnosis'));
    await new Promise((r) => setTimeout(r, 10));
    expect(container.textContent).toBe('');
  });
});

describe('DockerGateDialog', () => {
  it('closed: nothing; Docker ready: it closes itself and carries on', async () => {
    const onOpenChange = vi.fn();
    const onReady = vi.fn();
    renderUi(<DockerGateDialog open onOpenChange={onOpenChange} onReady={onReady} />, { withSettings: true, api: dockerApi({ probe: () => ({ state: 'running' }) }) });
    await waitFor(() => expect(onReady).toHaveBeenCalledTimes(1));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('auto restart only when Docker does not answer', async () => {
    const api = dockerApi({ probe: () => ({ state: 'not-responding' }) });
    renderUi(<DockerGateDialog open onOpenChange={() => undefined} autoRestart />, { withSettings: true, api });
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/api/docker/restart', { deep: false }));
    await userEvent.keyboard('{Escape}');
  });
});
