/**
 * Confronta, like a person uses it: "Confronta" on three tests in Risultati, the tray, the comparison
 * at the same measured context, "Confronta a", "Cosa cambia tra loro", a preset from a card; "Confronta
 * modelli" with two models; an older two-run link.
 */
import { expect, test } from '../fixtures';
import { goToHash } from '../ui/helpers';
import { h1, launchSeeded, scan, skipWelcome } from './bench-helpers';

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
