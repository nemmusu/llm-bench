import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { libApi, patchPointer, renderLib, world } from './fake';

vi.mock('echarts/core', () => ({ use: vi.fn(), init: vi.fn(() => ({ setOption: vi.fn(), resize: vi.fn(), dispose: vi.fn() })) }));
vi.mock('echarts/charts', () => ({ LineChart: {}, BarChart: {} }));
vi.mock('echarts/components', () => ({ AxisPointerComponent: {}, DataZoomComponent: {}, GridComponent: {}, LegendComponent: {}, MarkAreaComponent: {}, MarkLineComponent: {}, TooltipComponent: {} }));
vi.mock('echarts/renderers', () => ({ CanvasRenderer: {} }));

afterEach(() => {
  vi.restoreAllMocks();
});

const h1 = (name: string | RegExp) => screen.findByRole('heading', { level: 1, name });
/** The language a user starts with: a new install has no stored language (English). */
const apiIn = (language: 'it' | 'en', onboardingDone = true) => {
  const w = world();
  w.settings.language = language;
  w.settings.onboardingDone = onboardingDone;
  return libApi(w);
};

describe('the language menu in the title bar', () => {
  it('shows the current language, lists each in its own words and switches at once', async () => {
    const api = apiIn('it');
    renderLib('/', api);
    expect(await h1('Benchmark')).toBeTruthy();
    const button = screen.getByRole('button', { name: 'Lingua: Italiano' });
    expect(button.textContent).toBe('Italiano');
    await userEvent.click(button);
    const menu = await screen.findByRole('menu');
    expect(within(menu).getByText('Lingua')).toBeTruthy();
    const items = within(menu).getAllByRole('menuitemradio');
    expect(items.map((i) => [i.textContent, i.getAttribute('aria-checked'), i.getAttribute('lang')])).toEqual([
      ['English', 'false', 'en'],
      ['Italiano', 'true', 'it'],
    ]);
    await userEvent.click(items[0]!);
    await waitFor(() => expect(api.w.settings.language).toBe('en'));
    expect(screen.queryByRole('menu')).toBeNull();
    expect(screen.getByRole('navigation', { name: 'Main navigation' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Language: English' }).textContent).toBe('English');
    expect(document.documentElement.lang).toBe('en');
  });

  it('works with the keyboard only', async () => {
    const api = apiIn('en');
    renderLib('/', api);
    const button = await screen.findByRole('button', { name: 'Language: English' });
    button.focus();
    await userEvent.keyboard('{Enter}');
    const menu = await screen.findByRole('menu');
    // The chosen language has the focus first; the arrow moves to the other one.
    await waitFor(() => expect(document.activeElement?.textContent).toBe('English'));
    await userEvent.keyboard('{ArrowDown}');
    expect(document.activeElement?.textContent).toBe('Italiano');
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(api.w.settings.language).toBe('it'));
    expect(menu.isConnected).toBe(false);
    expect(await screen.findByRole('button', { name: 'Lingua: Italiano' })).toBe(document.activeElement);
    expect(screen.getByRole('navigation', { name: 'Navigazione principale' })).toBeTruthy();
  });
});

describe('the language on the welcome screen', () => {
  it('a new install greets in English; one click on "Italiano" switches everything', async () => {
    const api = apiIn('en', false);
    renderLib('/', api);
    expect(await h1('Welcome to LLM Bench')).toBeTruthy();
    const choice = screen.getByRole('radiogroup', { name: 'Language' });
    expect(within(choice).getByRole('radio', { name: 'English' }).getAttribute('aria-checked')).toBe('true');
    await userEvent.click(within(choice).getByRole('radio', { name: 'Italiano' }));
    expect(await h1('Benvenuto in LLM Bench')).toBeTruthy();
    await waitFor(() => expect(api.w.settings.language).toBe('it'));
    expect(screen.getByRole('radiogroup', { name: 'Lingua' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Lingua: Italiano' })).toBeTruthy();
    // Still the first launch: the welcome goes on in the chosen language.
    expect(screen.getByRole('button', { name: 'Salta, lo farò dopo' })).toBeTruthy();
    expect(api.w.settings.onboardingDone).toBe(false);
  });
});

describe('the language in Settings', () => {
  it('lists English first, each language in its own words', async () => {
    patchPointer();
    renderLib('/settings', apiIn('en'));
    expect(await h1('Settings')).toBeTruthy();
    await userEvent.click(screen.getByRole('combobox', { name: 'Language' }));
    expect((await screen.findAllByRole('option')).map((o) => o.textContent)).toEqual(['English', 'Italiano']);
  });
});
