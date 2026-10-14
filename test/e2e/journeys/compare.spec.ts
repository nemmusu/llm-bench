/**
 * Confronta, like a person uses it: "Confronta" on three tests in Risultati, the tray, the comparison
 * at the same measured context, "Confronta a", "Cosa cambia tra loro", a preset from a card; "Confronta
 * modelli" with two models; an older two-run link; three real searches read at their largest context,
 * on a 1024, 1366 and 1920 px window without sideways scrolling.
 */
import type { Locator } from '@playwright/test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, launchApp, ROOT, test, type AppHandle } from '../fixtures';
import { goToHash } from '../ui/helpers';
import { h1, launchSeeded, scan, seedRuns, skipWelcome, thisHostId } from './bench-helpers';

test.describe.configure({ timeout: 120_000 });

const MOE = '01K6WJ2F6R9T3Y8U1I4O7P5ASD';
const FULL = '01K6Y7Q2ZC4M8N3B5V9R1T0XWE';
const TABLE = 'Confronto misura per misura';

test('three tests from Risultati: who is faster at the same context, "Confronta a", what changes, a preset', async () => {
  const gb = await launchSeeded();
  try {
    const { page } = gb;
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await skipWelcome(page);
    await page.getByRole('navigation', { name: 'Navigazione principale' }).getByRole('link', { name: 'Risultati' }).click();
    await expect(h1(page, 'Risultati')).toBeVisible();
    // Every speed of the list says what it was measured on.
    const gemmaRow = page.getByRole('row', { name: /Gemma 4 31B/ });
    await expect(gemmaRow.getByText('a 512 token di contesto')).toBeVisible();
    await expect(gemmaRow.getByText('prompt da 4K')).toBeVisible();
    await expect(page.getByRole('columnheader', { name: 'Generazione (tok/s)' })).toBeVisible();

    // "Confronta" on three rows: the tray at the bottom counts them.
    for (const name of [/^Confronta Qwen3 30B A3B/, /^Confronta Gemma 4 31B/, /^Confronta Qwen3-8B-FP8/]) await page.getByRole('button', { name }).first().click();
    const tray = page.getByRole('region', { name: 'Da confrontare' });
    await expect(tray).toContainText('3 selezionati');
    await scan(page, 'results with the compare tray');
    await tray.getByRole('button', { name: 'Confronta', exact: true }).click();

    // Oldest first: A is the vLLM test of 4 Oct.
    await expect(h1(page, 'Confronta')).toBeVisible();
    const table = page.getByRole('table', { name: TABLE });
    await expect(table.getByRole('columnheader', { name: 'A · Qwen3-8B-FP8' })).toBeVisible();
    await expect(page.getByText(/^Scrive più in fretta B · Qwen3 30B A3B · Q4_K_M: 214,1 tok\/s \(scrittura con 512 token già nel contesto\)/)).toBeVisible();
    const decode = table.getByRole('row', { name: /^Generazione \(tok\/s\)/ });
    await expect(decode).toContainText('scrittura con 512 token già nel contesto');
    await expect(decode).toContainText('il più veloce');
    await expect(decode).toContainText('3,7 volte più lento');
    await scan(page, 'compare three');

    // "Confronta a" 4K: every speed again, at 4.096 tokens for all three.
    await page.getByRole('combobox', { name: 'Confronta a' }).click();
    await page.getByRole('option', { name: /^4K/ }).click();
    await expect(decode).toContainText('scrittura con 4.096 token già nel contesto');
    await expect(table.getByRole('row', { name: /^Lettura prompt/ })).toContainText('lettura di un prompt da 4.096 token');

    // "Cosa cambia tra loro": only what differs.
    await page.getByRole('button', { name: /Cosa cambia tra loro/ }).click();
    const diff = page.getByRole('table', { name: 'Cosa cambia tra loro' });
    await expect(diff).toContainText('vLLM v0.12.0');
    await expect(diff).toContainText('llama.cpp b11438');
    await scan(page, 'compare: what changes');

    // A preset from the vLLM card: the Benchmark page with those settings.
    await table.getByRole('columnheader', { name: 'A · Qwen3-8B-FP8' }).getByRole('button', { name: 'Usa questo preset' }).click();
    await expect(h1(page, 'Benchmark')).toBeVisible();
    await expect(page.getByRole('region', { name: 'Preset' })).toContainText('Preset da «Qwen3-8B-FP8»');
  } finally {
    await gb.close();
  }
});

test('"Confronta modelli": two models, each with its fastest configuration on this card', async () => {
  const gb = await launchSeeded();
  try {
    const { page } = gb;
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await skipWelcome(page);
    await page.getByRole('navigation', { name: 'Navigazione principale' }).getByRole('link', { name: 'Risultati' }).click();
    await page.getByRole('link', { name: 'Confronta modelli' }).click();
    await expect(h1(page, 'Confronta')).toBeVisible();
    const qwen = page.getByRole('listitem').filter({ has: page.getByRole('checkbox', { name: /^Qwen3 30B A3B/ }) });
    await expect(qwen).toContainText('214,1 tok/s · scrittura con 512 token già nel contesto');
    await page.getByRole('checkbox', { name: /^Qwen3 30B A3B/ }).click();
    await page.getByRole('checkbox', { name: /^Gemma 4 31B/ }).click();
    await expect(page.getByText('Scelti 2 su 4')).toBeVisible();
    await scan(page, 'compare models start');
    await page.getByRole('button', { name: 'Confronta (2)' }).click();
    const table = page.getByRole('table', { name: TABLE });
    await expect(table.getByRole('columnheader', { name: /^A · Qwen3 30B A3B/ })).toBeVisible();
    await expect(table.getByRole('columnheader', { name: /^B · Gemma 4 31B/ })).toBeVisible();
    await expect(table.getByRole('row', { name: /^Scrittura per utente/ })).toContainText('con 4 utenti insieme, prompt da 512 token ciascuno');
  } finally {
    await gb.close();
  }
});

test('an older two-run link (?a=&b=) still opens the comparison', async () => {
  const gb = await launchSeeded();
  try {
    const { page } = gb;
    await skipWelcome(page);
    await goToHash(page, `#/compare?a=${MOE}&b=${FULL}`);
    const table = page.getByRole('table', { name: TABLE });
    await expect(table.getByRole('columnheader', { name: 'A · Qwen3 30B A3B · Q4_K_M' })).toBeVisible();
    await expect(table.getByRole('columnheader', { name: 'B · Qwen3 8B · Q4_K_M' })).toBeVisible();
    await expect(table.getByRole('row', { name: /^Generazione \(tok\/s\)/ })).toContainText('scrittura con 512 token già nel contesto');
  } finally {
    await gb.close();
  }
});

/** The user's three searches (test/fixtures/runs/tune, sanitized), with the seeded tests. */
const TUNES = ['2026-10-09_18-10-53_compare-vllm-208k.json', '2026-10-09_19-42-43_compare-llamacpp-256k.json', '2026-10-09_20-29-32_compare-qwopus-256k.json'];
const TUNE_IDS = ['01M4GXRQZS9SKTC0HBQXVLLM08', '01M4H30X6C8H55EFMBE6LLAMA0', '01M4H5PMD3B0EWHZC7MKQWOPUS'];

async function launchWithTunes(): Promise<AppHandle> {
  const userData = mkdtempSync(path.join(os.tmpdir(), 'gpubench-e2e-compare-'));
  const results = path.join(userData, 'results');
  seedRuns(results);
  for (const f of TUNES) {
    const text = readFileSync(path.join(ROOT, 'test', 'fixtures', 'runs', 'tune', f), 'utf8').replaceAll('__THIS_HOST_ID__', thisHostId()).replaceAll('__THIS_PC__', os.hostname());
    writeFileSync(path.join(results, f), text);
  }
  return launchApp({ userData });
}

/** The window's content at that size (the sidebar included, as a person sees it). */
async function resize(gb: AppHandle, width: number, height = 900): Promise<void> {
  await gb.app.evaluate(({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0]!.setContentSize(w!, h!), [width, height]);
  await gb.page.waitForFunction((w) => window.innerWidth === w, width);
}

/** How wide what scrolls around the element is against its box (equal: nothing scrolls sideways). */
async function widths(el: Locator, own = true): Promise<{ scroll: number; client: number }> {
  return el.evaluate((e, self) => {
    const box = self ? e : e.parentElement!;
    return { scroll: box.scrollWidth, client: box.clientWidth };
  }, own);
}

test('three searches: each at its largest context, the smaller one apart, both charts; no sideways scrolling from 1024 to 1920 px', async () => {
  const gb = await launchWithTunes();
  try {
    const { page } = gb;
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await skipWelcome(page);
    await resize(gb, 1366);
    await goToHash(page, `#/compare?ids=${TUNE_IDS.join(',')}`);
    const table = page.getByRole('table', { name: TABLE });
    await expect(table).toBeVisible();
    await expect(page.getByRole('combobox', { name: 'Confronta a' })).toHaveText('Contesto massimo');
    await expect(table.getByRole('columnheader', { name: /^A · nvidia/ })).toContainText('Velocità con il contesto pieno a 208K');
    await expect(table.getByRole('columnheader', { name: /^C · Qwopus/ })).toContainText('Velocità con il contesto pieno a 256K');
    await expect(page.getByText(/^Scrive più in fretta C · Qwopus.*\(con il contesto pieno a 256K\)/)).toBeVisible();
    await expect(page.getByText(/^A · nvidia\/Qwen3\.8-27B-NVFP4 · MODELOPT ha un contesto massimo più piccolo \(208K\)/)).toBeVisible();
    await expect(table.getByRole('row', { name: /^Generazione \(tok\/s\)/ })).toContainText('contesto più piccolo: non si confronta');
    await expect(table.getByRole('row', { name: /^Scrittura più veloce/ })).toContainText('a 1K di contesto');
    await expect(table.getByRole('row', { name: /^Contesto tenuto in memoria/ })).toContainText('il motore non lo dice');
    await expect(page.getByText('Scrittura al crescere del contesto')).toBeVisible();
    await expect(page.getByText('Lettura al crescere del contesto')).toBeVisible();
    await scan(page, 'compare three searches');
    for (const width of [1024, 1366, 1920]) {
      await resize(gb, width);
      const box = await widths(page.getByRole('region', { name: TABLE }));
      expect(box.scroll, `compare table at ${width} px`).toBeLessThanOrEqual(box.client + 1);
    }
    // Risultati at the same sizes: the whole list in view.
    await page.getByRole('navigation', { name: 'Navigazione principale' }).getByRole('link', { name: 'Risultati' }).click();
    await expect(h1(page, 'Risultati')).toBeVisible();
    await expect(page.getByRole('row', { name: /Qwopus3\.8/ })).toContainText('a 256K di contesto');
    for (const width of [1024, 1366, 1920]) {
      await resize(gb, width);
      const box = await widths(page.getByRole('table').first(), false);
      expect(box.scroll, `results table at ${width} px`).toBeLessThanOrEqual(box.client + 1);
    }
  } finally {
    await gb.close();
  }
});
