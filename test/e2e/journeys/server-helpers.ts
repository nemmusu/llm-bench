/**
 * The Server page in the journeys: a running server's card and address, and the main process's test
 * hooks (GPUBENCH_TEST_HOOKS=1, see src/main/shell.ts ShellTestHooks): Playwright cannot click the
 * OS tray, so the journeys read its menu and run its items through `globalThis.__gpubench`.
 */
import { expect, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import type { ShellTestHooks } from '../../../src/main/shell';

/** A running server's card on the Server page ("Server <name> sulla porta <port>"). */
export function serverCard(page: Page, name: string | RegExp = /.*/): Locator {
  const label = typeof name === 'string' ? new RegExp(`^Server ${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} sulla porta \\d+$`) : new RegExp(`^Server ${name.source} sulla porta \\d+$`);
  return page.getByRole('region', { name: label });
}

/** The OpenAI-compatible base URL the card shows. */
export async function cardUrl(card: Locator): Promise<string> {
  const text = await card.getByText(/^http:\/\/127\.0\.0\.1:\d+\/v1$/).first().textContent();
  return text!.trim();
}

/** HTTP status of GET <url>/models, 0 when nothing answers. */
export function modelsStatus(url: string): Promise<number> {
  return fetch(`${url}/models`).then(
    (r) => r.status,
    () => 0,
  );
}

type HookName = keyof ShellTestHooks;

/** Calls one of the main process's test hooks. */
export function hook<K extends HookName>(app: ElectronApplication, name: K, ...args: Parameters<ShellTestHooks[K]>): Promise<ReturnType<ShellTestHooks[K]>> {
  return app.evaluate(
    (_electron, [n, a]) => {
      const hooks = (globalThis as unknown as { __gpubench: Record<string, (...x: unknown[]) => unknown> }).__gpubench;
      return hooks[n]!(...a);
    },
    [name, args] as [string, unknown[]],
  ) as Promise<ReturnType<ShellTestHooks[K]>>;
}

/** Waits until the tray menu has a line matching `line`. */
export async function expectTrayLine(app: ElectronApplication, line: RegExp): Promise<void> {
  await expect.poll(async () => (await hook(app, 'trayMenu')).some((l) => line.test(l)), { timeout: 20_000 }).toBe(true);
}
