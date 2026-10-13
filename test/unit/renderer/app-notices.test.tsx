import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
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

const OLD = 'C:\\Users\\anna\\AppData\\Roaming\\GPU Bench';

/** The toast (a list item of sonner's region) that says `text`. */
const toastOf = (text: string | RegExp) => screen.getByText(text).closest('li') as HTMLElement;
const dismissed = (api: ReturnType<typeof fakeApi>) => vi.mocked(api.del).mock.calls.map((c) => c[0]);

describe('the rename’s one-time notices (GPU Bench → LLM Bench)', () => {
  it('moved, and the secrets to type again: toasts that stay until closed; dismissed in the core only then', async () => {
    const api = fakeApi({ onboardingDone: true, hasHfToken: true });
    api.notices = [
      { id: 'data-moved', kind: 'data-moved', mode: 'moved', from: OLD },
      { id: 'secret-unreadable:hf-token', kind: 'secret-unreadable', secret: 'hf-token', renamed: true },
      { id: 'secret-unreadable:server-api-key', kind: 'secret-unreadable', secret: 'server-api-key', renamed: true },
    ];
    renderApp('/', api);
    expect(await screen.findByText('I tuoi dati di GPU Bench sono stati spostati in LLM Bench')).toBeTruthy();
    expect(screen.getByText('Risultati, impostazioni, preset e motori installati sono quelli di prima. I modelli restano dove sono.')).toBeTruthy();
    expect(screen.getByText('Reinserisci il token di Hugging Face: dopo il cambio di nome non è più leggibile')).toBeTruthy();
    expect(screen.getByText(/La chiave API dei server in rete non è più leggibile dopo il cambio di nome/)).toBeTruthy();
    // The token file is gone: the settings stop saying one is saved.
    await waitFor(() => expect(api.settings.hasHfToken).toBe(false));
    // Shown, not yet read: still there for a window opened again.
    expect(dismissed(api)).toEqual([]);
    // Shown once: the settings changing does not show them again.
    expect(screen.getAllByText('I tuoi dati di GPU Bench sono stati spostati in LLM Bench')).toHaveLength(1);
    // Closed (the × says "Chiudi"): never again.
    await userEvent.click(within(toastOf('I tuoi dati di GPU Bench sono stati spostati in LLM Bench')).getByRole('button', { name: 'Chiudi' }));
    await userEvent.click(within(toastOf(/La chiave API dei server in rete/)).getByRole('button', { name: 'Chiudi' }));
    expect(dismissed(api)).toEqual(['/api/app/notices/data-moved', '/api/app/notices/secret-unreadable%3Aserver-api-key']);
    // "Apri le impostazioni": where the token is typed; the notice is done too.
    await userEvent.click(screen.getByRole('button', { name: 'Apri le impostazioni' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Impostazioni' })).toBeTruthy();
    expect(dismissed(api)).toContain('/api/app/notices/secret-unreadable%3Ahf-token');
  });

  it('copied (GPU Bench was open), engines left behind, secrets unreadable without a rename; a failed dismissal is ignored', async () => {
    const api = fakeApi({ onboardingDone: true });
    api.notices = [
      { id: 'data-moved', kind: 'data-moved', mode: 'copied', from: OLD, enginesIn: `${OLD}\\engines` },
      { id: 'secret-unreadable:hf-token', kind: 'secret-unreadable', secret: 'hf-token', renamed: false },
      { id: 'secret-unreadable:server-api-key', kind: 'secret-unreadable', secret: 'server-api-key', renamed: false },
    ];
    api.del = vi.fn(async () => {
      throw new Error('core gone');
    }) as typeof api.del;
    renderApp('/', api);
    expect(await screen.findByText('I tuoi dati di GPU Bench sono stati copiati in LLM Bench')).toBeTruthy();
    expect(
      screen.getByText(
        `Non ho potuto spostare la cartella di GPU Bench (forse GPU Bench era aperto): è rimasta com’era (${OLD}), puoi eliminarla quando non ti serve più. I modelli restano dove sono. I motori installati sono rimasti lì (${OLD}\\engines): reinstallali dalla pagina Motori.`,
      ),
    ).toBeTruthy();
    expect(screen.getByText('Reinserisci il token di Hugging Face: quello salvato non è più leggibile')).toBeTruthy();
    expect(screen.getByText(/La chiave API salvata dei server in rete non è più leggibile/)).toBeTruthy();
    await userEvent.click(within(toastOf('I tuoi dati di GPU Bench sono stati copiati in LLM Bench')).getByRole('button', { name: 'Chiudi' }));
    await waitFor(() => expect(api.del).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByText('I tuoi dati di GPU Bench sono stati copiati in LLM Bench')).toBeNull());
  });

  it('copied without engines left behind; nothing to say: no toast', async () => {
    const api = fakeApi({ onboardingDone: true });
    api.notices = [{ id: 'data-moved', kind: 'data-moved', mode: 'copied', from: OLD }];
    renderApp('/', api);
    expect(await screen.findByText(`Non ho potuto spostare la cartella di GPU Bench (forse GPU Bench era aperto): è rimasta com’era (${OLD}), puoi eliminarla quando non ti serve più. I modelli restano dove sono.`)).toBeTruthy();
    const quiet = fakeApi({ onboardingDone: true });
    renderApp('/', quiet);
    await screen.findAllByRole('heading', { level: 1, name: 'Benchmark' });
    expect(quiet.del).not.toHaveBeenCalled();
  });
});
