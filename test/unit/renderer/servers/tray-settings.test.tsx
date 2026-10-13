/** Settings → "Area di notifica": what closing the window does, the login switch, the no-tray warning. */
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fakeApi, renderApp } from '../helpers';

vi.mock('echarts/core', () => ({ use: vi.fn(), init: vi.fn(() => ({ setOption: vi.fn(), resize: vi.fn(), dispose: vi.fn() })) }));
vi.mock('echarts/charts', () => ({ LineChart: {}, BarChart: {} }));
vi.mock('echarts/components', () => ({ AxisPointerComponent: {}, DataZoomComponent: {}, GridComponent: {}, LegendComponent: {}, MarkAreaComponent: {}, MarkLineComponent: {}, TooltipComponent: {} }));
vi.mock('echarts/renderers', () => ({ CanvasRenderer: {} }));

afterEach(() => {
  delete (window as { gpubench?: unknown }).gpubench;
  vi.restoreAllMocks();
});

const desktop = (tray: boolean) => {
  const shellInfo = vi.fn(async () => ({ tray }));
  (window as { gpubench?: unknown }).gpubench = { platform: 'linux', setTitleBarTheme: vi.fn(async () => undefined), shellInfo };
  return shellInfo;
};

describe('tray settings', () => {
  it('in the desktop app: the close choice and the login switch are saved', async () => {
    const shellInfo = desktop(true);
    const api = fakeApi({ onboardingDone: true });
    renderApp('/settings', api);
    const stay = await screen.findByRole('radio', { name: 'Resta nell’area di notifica se c’è un server attivo' });
    expect(stay.getAttribute('aria-checked')).toBe('true');
    await userEvent.click(screen.getByRole('radio', { name: 'Esci sempre' }));
    await waitFor(() => expect(api.settings.closeBehavior).toBe('quit'));
    await userEvent.click(screen.getByRole('radio', { name: 'Resta sempre nell’area di notifica' }));
    await waitFor(() => expect(api.settings.closeBehavior).toBe('tray'));
    const login = screen.getByRole('switch', { name: 'Avvia GPU Bench all’accesso' });
    expect(screen.getByText('Parte nell’area di notifica, con i preset segnati «Avvia all’apertura di GPU Bench».')).toBeTruthy();
    await userEvent.click(login);
    await waitFor(() => expect(api.settings.launchAtLogin).toBe(true));
    await waitFor(() => expect(shellInfo).toHaveBeenCalled());
    expect(screen.queryByText(/Questo desktop non mostra l’area di notifica/)).toBeNull();
  });

  it('a desktop without a notification area: the window is minimized instead, and the section says so', async () => {
    desktop(false);
    renderApp('/settings', fakeApi({ onboardingDone: true }));
    expect(await screen.findByText(/Questo desktop non mostra l’area di notifica/)).toBeTruthy();
  });

  it('in a browser: the login switch is off and says it is for the desktop app', async () => {
    renderApp('/settings', fakeApi({ onboardingDone: true }));
    const login = await screen.findByRole('switch', { name: 'Avvia GPU Bench all’accesso' });
    expect((login as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('Disponibile nell’app per desktop.')).toBeTruthy();
  });
});
