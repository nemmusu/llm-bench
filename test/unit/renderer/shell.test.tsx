import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hasWindowControlsOverlay, isMac } from '../../../src/renderer/components/shell/title-bar';
import { fakeApi, renderApp } from './helpers';

vi.mock('echarts/core', () => ({ use: vi.fn(), init: vi.fn(() => ({ setOption: vi.fn(), resize: vi.fn(), dispose: vi.fn() })) }));
vi.mock('echarts/charts', () => ({ LineChart: {}, BarChart: {} }));
vi.mock('echarts/components', () => ({
  AxisPointerComponent: {},
  DataZoomComponent: {},
  GridComponent: {},
  LegendComponent: {},
  MarkAreaComponent: {},
  MarkLineComponent: {},
  TooltipComponent: {},
}));
vi.mock('echarts/renderers', () => ({ CanvasRenderer: {} }));

beforeEach(() => {
  localStorage.clear();
});
afterEach(() => {
  delete (window as { gpubench?: unknown }).gpubench;
  vi.restoreAllMocks();
});

describe('title bar helpers', () => {
  it('knows which platforms draw native controls', () => {
    expect(hasWindowControlsOverlay('win32')).toBe(true);
    expect(hasWindowControlsOverlay('linux')).toBe(true);
    expect(hasWindowControlsOverlay('darwin')).toBe(false);
    expect(hasWindowControlsOverlay(undefined)).toBe(false);
    expect(isMac('darwin')).toBe(true);
    expect(isMac('win32')).toBe(false);
  });
});

describe('app shell', () => {
  it('shows the sidebar, the page title and the core version', async () => {
    renderApp('/');
    expect(await screen.findByRole('heading', { level: 1, name: 'Benchmark' })).toBeTruthy();
    const nav = screen.getByRole('navigation', { name: 'Navigazione principale' });
    for (const name of ['Benchmark', 'Risultati', 'Modelli', 'Motori', 'Monitor GPU', 'Impostazioni']) {
      expect(within(nav).getByRole('link', { name })).toBeTruthy();
    }
    expect(within(nav).getByRole('link', { name: 'Benchmark' }).getAttribute('aria-current')).toBe('page');
    expect((await screen.findByLabelText('Versione 0.1.0')).textContent).toBe('v0.1.0');
    expect(screen.getByRole('status').textContent).toContain('Connesso');
  });

  it('navigates with the sidebar', async () => {
    renderApp('/');
    await screen.findByRole('heading', { level: 1, name: 'Benchmark' });
    await userEvent.click(screen.getByRole('link', { name: 'Monitor GPU' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Monitor GPU' })).toBeTruthy();
    await userEvent.click(screen.getByRole('link', { name: 'Impostazioni' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Impostazioni' })).toBeTruthy();
  });

  it('collapses the sidebar and remembers it', async () => {
    renderApp('/');
    await userEvent.click(await screen.findByRole('button', { name: 'Riduci la barra laterale' }));
    expect(localStorage.getItem('gpubench.sidebarCollapsed')).toBe('1');
    expect(screen.getByRole('link', { name: 'Risultati' })).toBeTruthy();
    expect(screen.getByRole('status', { name: 'Connesso al motore interno' })).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Espandi la barra laterale' }));
    expect(localStorage.getItem('gpubench.sidebarCollapsed')).toBe('0');
  });

  it('survives a broken localStorage', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('denied');
    });
    renderApp('/');
    await userEvent.click(await screen.findByRole('button', { name: 'Riduci la barra laterale' }));
    expect(screen.getByRole('button', { name: 'Espandi la barra laterale' })).toBeTruthy();
  });

  it('shows the disconnected state', async () => {
    const api = fakeApi({ onboardingDone: true });
    renderApp('/', api);
    await screen.findByRole('heading', { level: 1, name: 'Benchmark' });
    act(() => api.setConnected(false));
    expect(screen.getByRole('status').textContent).toContain('Non connesso');
  });

  it('toggles the theme from the title bar and syncs the native caption', async () => {
    const setTitleBarTheme = vi.fn(async () => undefined);
    (window as { gpubench?: unknown }).gpubench = { platform: 'win32', setTitleBarTheme };
    const api = fakeApi({ onboardingDone: true, theme: 'light' });
    renderApp('/', api);
    await screen.findByRole('heading', { level: 1, name: 'Benchmark' });
    await userEvent.click(screen.getByRole('button', { name: 'Cambia tema' }));
    await waitFor(() => expect(api.settings.theme).toBe('dark'));
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(setTitleBarTheme).toHaveBeenLastCalledWith({ background: '#0b0d12', symbols: '#e6e8ee' });
    await userEvent.click(screen.getByRole('button', { name: 'Cambia tema' }));
    await waitFor(() => expect(api.settings.theme).toBe('light'));
  });

  it('skip link moves focus to the content', async () => {
    renderApp('/');
    await screen.findByRole('heading', { level: 1, name: 'Benchmark' });
    await userEvent.click(screen.getByRole('link', { name: 'Vai al contenuto' }));
    expect(document.activeElement?.id).toBe('main');
  });

  it('renders the not-found page', async () => {
    renderApp('/does-not-exist');
    expect(await screen.findByRole('heading', { name: 'Pagina non trovata' })).toBeTruthy();
  });
});

describe('command palette', () => {
  async function openPalette() {
    await screen.findByRole('heading', { level: 1 });
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    return screen.findByRole('dialog');
  }

  it('opens with Ctrl+K and navigates', async () => {
    renderApp('/');
    const dialog = await openPalette();
    await userEvent.type(within(dialog).getByRole('combobox'), 'Monitor');
    await userEvent.keyboard('{Enter}');
    expect(await screen.findByRole('heading', { level: 1, name: 'Monitor GPU' })).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('toggles closed with the shortcut and opens from the title bar', async () => {
    renderApp('/');
    await openPalette();
    fireEvent.keyDown(window, { key: 'K', metaKey: true });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true, altKey: true });
    expect(screen.queryByRole('dialog')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Apri la palette dei comandi' }));
    expect(await screen.findByRole('dialog', { name: 'Palette dei comandi' })).toBeTruthy();
  });

  it('runs preference and action commands', async () => {
    const api = fakeApi({ onboardingDone: true });
    renderApp('/', api);
    const pick = async (name: string | RegExp) => {
      const dialog = await openPalette();
      await userEvent.click(within(dialog).getByRole('option', { name }));
    };
    await pick('Tema scuro');
    await waitFor(() => expect(api.settings.theme).toBe('dark'));
    await pick('Tema chiaro');
    await waitFor(() => expect(api.settings.theme).toBe('light'));
    await pick('Tema come il sistema');
    await waitFor(() => expect(api.settings.theme).toBe('system'));
    await pick('Densità compatta');
    await waitFor(() => expect(api.settings.density).toBe('compact'));
    await pick('Densità comoda');
    await waitFor(() => expect(api.settings.density).toBe('comfortable'));
    await pick('Attiva la modalità esperto');
    await waitFor(() => expect(api.settings.expertMode).toBe(true));
    await pick('Disattiva la modalità esperto');
    await waitFor(() => expect(api.settings.expertMode).toBe(false));
    await pick('Switch to English');
    await waitFor(() => expect(api.settings.language).toBe('en'));
    await pick('Passa all’italiano');
    await waitFor(() => expect(api.settings.language).toBe('it'));
    await pick('Confronta modelli o test');
    expect(await screen.findByRole('heading', { level: 1, name: 'Confronta' })).toBeTruthy();
    await pick('Avvia benchmark');
    expect(await screen.findByRole('heading', { level: 1, name: 'Benchmark' })).toBeTruthy();
    // Eleven trips through the palette and four pages: more than the default 5 s on a busy machine.
  }, 20_000);
});
