/** "Usa questo preset" / "Avvia il server così" of a whole run (no tune combination): its own launch parameters. */
import { QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, describe, expect, it } from 'vitest';
import { PresetActions } from '../../../../src/renderer/components/presets/preset-actions';
import { TooltipProvider } from '../../../../src/renderer/components/ui/tooltip';
import { I18nProvider } from '../../../../src/renderer/i18n';
import { ApiProvider } from '../../../../src/renderer/lib/api-context';
import { SettingsProvider } from '../../../../src/renderer/lib/settings';
import { newQueryClient } from '../helpers';
import { IDS, seeded } from '../bench/fixtures';
import { presetOf } from '../../../../src/renderer/components/bench/rerun';
import { benchApi, ENGINES_DIR, localModel } from '../bench/world';

beforeAll(() => {
  Object.assign(Element.prototype, { hasPointerCapture: () => false, releasePointerCapture: () => undefined, scrollIntoView: () => undefined });
});

describe('preset of a run saved before the context sweep existed', () => {
  it('quotes its headline numbers (no sweep list in the file)', () => {
    const run = seeded(IDS.full);
    delete (run.metrics as { contextSweep?: unknown }).contextSweep;
    const preset = presetOf(run, [localModel('qwen3-8b', { weakKey: run.model.weakKey })], ENGINES_DIR);
    expect(preset.draft.provenance?.decodeTps).toBe(run.metrics.latency.find((p) => p.promptTokens === 512)!.decodeTps.median);
  });
});

describe('preset actions of a run', () => {
  it('use the run’s own launch parameters', async () => {
    const run = seeded(IDS.full);
    run.launch = { ...run.launch, params: { ...run.launch.params, contextSize: 12288 } };
    const api = benchApi({ runs: [run] });
    const root = createRootRoute();
    const tree = root.addChildren([
      createRoute({ getParentRoute: () => root, path: '/x', component: () => <PresetActions run={run} /> }),
      createRoute({ getParentRoute: () => root, path: '/', component: () => <p>home</p> }),
    ]);
    const router = createRouter({ routeTree: tree, history: createMemoryHistory({ initialEntries: ['/x'] }) });
    render(
      <ApiProvider api={api}>
        <QueryClientProvider client={newQueryClient()}>
          <SettingsProvider>
            <I18nProvider lang="it">
              <TooltipProvider>
                <RouterProvider router={router as never} />
              </TooltipProvider>
            </I18nProvider>
          </SettingsProvider>
        </QueryClientProvider>
      </ApiProvider>,
    );
    await userEvent.click(await screen.findByRole('button', { name: 'Avvia il server così' }));
    await waitFor(() => expect(api.calls.find((c) => c.path === '/api/servers/plan')?.body).toMatchObject({ params: { contextSize: 12288 } }));
    await userEvent.click(await screen.findByRole('button', { name: 'Annulla' }));
    await userEvent.click(screen.getByRole('button', { name: 'Usa questo preset' }));
    expect(await screen.findByText('home')).toBeTruthy();
  });
});
