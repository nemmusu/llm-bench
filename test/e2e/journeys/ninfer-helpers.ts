/**
 * NInfer's journeys on either host, with the same story: on Windows NInfer runs inside WSL (a fake
 * wsl.exe with an "Ubuntu-24.04" distro), on Linux on this PC (the same fake as a Linux host:
 * GPUBENCH_NINFER_HOST). Its programs, its builds and its ninfer-serve are the fakes' either way.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Locator, Page } from '@playwright/test';
import { ROOT } from '../fixtures';

export const WIN = process.platform === 'win32';
const FAKE = [process.execPath, path.join(ROOT, 'test', 'fakes', 'fake-wsl', 'fake-wsl.mjs')];

/** The environment that gives the app its NInfer host (`config`: the fake's world, FAKE_WSL_CONFIG). */
export function ninferEnv(userData: string, config?: Record<string, unknown>): Record<string, string> {
  return {
    ...(WIN ? { GPUBENCH_WSL: JSON.stringify(FAKE) } : { GPUBENCH_NINFER_HOST: JSON.stringify([...FAKE, '--host']) }),
    FAKE_WSL_STATE: stateDir(userData),
    ...(config ? { FAKE_WSL_CONFIG: JSON.stringify(config) } : {}),
  };
}

const stateDir = (userData: string): string => path.join(userData, 'fake-wsl');

/** What changes on the fake host meanwhile (the user did something there by hand: `sudo apt install …`). */
export function changeHost(userData: string, patch: Record<string, unknown>): void {
  const file = path.join(stateDir(userData), 'config.json');
  let now: Record<string, unknown> = {};
  try {
    now = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  } catch {
    /* nothing changed yet */
  }
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ ...now, ...patch }, null, 2));
}

/** The official build saved where the fake has it (settings.ninfer). */
export const OFFICIAL_SAVED = WIN ? { wsl: { distro: 'Ubuntu-24.04', path: '/home/user/ninfer' } } : { native: { path: '/home/user/ninfer' } };

/** "dentro Ubuntu-24.04" / "su questo PC", as the app says where NInfer is built. */
export const WHERE = WIN ? 'dentro Ubuntu-24.04' : 'su questo PC';

/** A saved build's folder as its row shows it ("/home/user/ninfer · Ubuntu-24.04"). */
export const folderText = (dir: string): string => (WIN ? `${dir} · Ubuntu-24.04` : dir);

/** The row's "Cartella" value exactly: on Linux the bare path also shows in hints and in the commands. */
export function folderValue(row: Locator, dir: string): Locator {
  const text = folderText(dir).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return row.getByRole('definition').filter({ hasText: new RegExp(`^${text}$`) });
}

/** What the exact command shows of where NInfer runs: its distro on Windows, its program on Linux. */
export const IN_COMMAND = WIN ? 'Ubuntu-24.04' : '/home/user/ninfer/build/apps/ninfer-serve';

/** NInfer's name in the engine pickers. */
export const ENGINE = WIN ? 'NInfer (WSL)' : 'NInfer';

/** Picks NInfer itself (not a variant of it listed under it) in the Benchmark's engine picker. */
export async function chooseNinfer(page: Page): Promise<void> {
  await page.getByRole('combobox', { name: 'Cambia motore' }).click();
  await page
    .getByRole('option')
    .filter({ hasText: new RegExp(`^${ENGINE.replace(/[()]/g, '\\$&')}`) })
    .filter({ hasNotText: 'NInfer-all' })
    .first()
    .click();
}

/** The NInfer card in Motori and its two builds. */
export function ninferCard(page: Page): { card: Locator; official: Locator; all: Locator } {
  const card = page.getByRole('region', { name: 'NInfer', exact: true });
  return {
    card,
    official: card.getByRole('region', { name: 'NInfer (ufficiale)' }),
    all: card.getByRole('region', { name: 'NInfer-all (serve per i modelli GGUF-NInfer)' }),
  };
}
