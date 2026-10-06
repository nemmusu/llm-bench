/**
 * Shell details that depend on the platform and the OS settings: macOS shortcuts, reduced motion,
 * a collapsed sidebar while the core is unreachable, a broken localStorage. Kept in their own file
 * because motion reads prefers-reduced-motion once per module instance.
 */
import { act, screen } from '@testing-library/react';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { bridge, libApi, renderLib } from './fake';

vi.mock('echarts/core', () => ({ use: vi.fn(), init: vi.fn(() => ({ setOption: vi.fn(), resize: vi.fn(), dispose: vi.fn() })) }));
vi.mock('echarts/charts', () => ({ LineChart: {}, BarChart: {} }));
vi.mock('echarts/components', () => ({ AxisPointerComponent: {}, DataZoomComponent: {}, GridComponent: {}, LegendComponent: {}, MarkAreaComponent: {}, MarkLineComponent: {}, TooltipComponent: {} }));
vi.mock('echarts/renderers', () => ({ CanvasRenderer: {} }));

beforeAll(() => {
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({ matches: query.includes('reduce'), media: query, addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn() })),
  );
});
afterAll(() => {
  vi.unstubAllGlobals();
  delete (window as { gpubench?: unknown }).gpubench;
});

describe('shell on macOS with reduced motion', () => {
  it('shows ⌘K, keeps pages still, and the collapsed status dot follows the core', async () => {
    bridge({ platform: 'darwin' });
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockReturnValue('1');
    const api = libApi();
    renderLib('/settings', api);
    const palette = await screen.findByRole('button', { name: 'Apri la palette dei comandi' });
    expect(palette.getAttribute('aria-keyshortcuts')).toBe('Meta+K');
    expect(palette.textContent).toContain('⌘');
    expect(screen.getByRole('status', { name: 'Connesso al motore interno' })).toBeTruthy();
    act(() => api.setConnected(false));
    expect(screen.getByRole('status', { name: 'Motore interno non raggiungibile' })).toBeTruthy();
    getItem.mockRestore();
  });

  it('a localStorage that throws leaves the sidebar expanded', async () => {
    const original = Object.getOwnPropertyDescriptor(window, 'localStorage');
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get() {
        throw new Error('denied');
      },
    });
    try {
      renderLib('/settings', libApi());
      expect(await screen.findByRole('button', { name: 'Riduci la barra laterale' })).toBeTruthy();
    } finally {
      if (original) Object.defineProperty(window, 'localStorage', original);
    }
  });
});
