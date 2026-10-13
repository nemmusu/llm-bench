/**
 * "Comandi per questo modello" like a person: a ready recipe (YaRN 300K) attached to the model, seen on
 * the Benchmark page, used by a quick test whose saved command has the RoPE flags; commands written by
 * hand used by "Avvia server"; the PrismML recipe of a Bonsai model with no fork set up yet.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildGguf, llamaLikeGguf } from '../../fakes/fake-hub/model-files.mjs';
import { expect, launchApp, test } from '../fixtures';
import { h1, scan, skipWelcome } from './bench-helpers';
import { openPage } from './library-helpers';

test.describe.configure({ timeout: 180_000 });

const FAST_ENGINE = { FAKE_ENGINE_PROFILE: JSON.stringify({ loadMsWarm: 300, loadMsCold: 300, prefillTps: 15000, decodeTps: 1500, tokensPerChunk: 4 }) };

test('a ready recipe: YaRN 300K on the model, the Benchmark chip, a quick test whose command has the RoPE flags', async () => {
  const gb = await launchApp({ env: FAST_ENGINE });
  try {
    const { page } = gb;
    await skipWelcome(page);
    await openPage(page, 'Modelli');
    await page.getByRole('button', { name: 'Comandi per Qwen3-0.6B-Q4_K_M' }).click();
    const section = page.getByRole('dialog', { name: /^Comandi per questo modello · Qwen3-0\.6B-Q4_K_M/ });
    await expect(section.getByText('Nessun comando particolare: il modello parte con le impostazioni normali.')).toBeVisible();
    await section.getByRole('button', { name: 'Scegli da una ricetta pronta' }).click();
    const library = page.getByRole('dialog', { name: 'Ricette pronte' });
    // The model was trained on 40.960 tokens: 300K is ×7,5.
    await expect(library.getByText('×7,50 rispetto ai 40.960 di addestramento')).toBeVisible();
    await scan(page, 'ready recipes');
    await library.getByRole('button', { name: 'Usa: Contesto esteso con YaRN' }).click();
    const editor = page.getByRole('dialog', { name: 'Scrivi i comandi per Qwen3-0.6B-Q4_K_M' });
    await expect(editor.getByText('Oltre i 40K token la qualità non è garantita')).toBeVisible();
    // The live command, from the core: the same flags a run will use.
    const live = editor.getByRole('region', { name: 'Comando completo' });
    await expect(live).toContainText('--rope-scaling', { timeout: 30_000 });
    await expect(live).toContainText('--yarn-orig-ctx');
    await scan(page, 'recipe editor');
    await editor.getByRole('button', { name: 'Salva' }).click();
    await expect(page.getByText('Comandi salvati').first()).toBeVisible();
    await expect(section.getByText('YaRN 300K')).toBeVisible();
    await scan(page, 'model commands');
    await section.getByRole('button', { name: 'Chiudi' }).click();
    await expect(page.getByText('Comandi: Qwen3-0.6B-Q4_K_M').first()).toBeVisible();

    // The Benchmark page says it, with the switch on.
    await openPage(page, 'Benchmark');
    await expect(page.getByText('Usa i comandi di questo modello')).toBeVisible();
    await expect(page.getByRole('switch', { name: 'Usa i comandi di questo modello' })).toBeChecked();
    await expect(page.getByText('YaRN 300K').first()).toBeVisible();
    await expect(page.getByText('Oltre il contesto di addestramento')).toBeVisible({ timeout: 30_000 });
    await scan(page, 'benchmark with the model commands');

    await page.getByRole('button', { name: 'Avvia benchmark' }).click();
    await page.getByRole('dialog', { name: 'Prima di iniziare scarico quello che manca' }).getByRole('button', { name: 'Scarica e avvia' }).click();
    await expect(h1(page, /Qwen3-0\.6B-Q4_K_M/)).toBeVisible({ timeout: 90_000 });
    await expect(page.getByText('Completato', { exact: true })).toBeVisible();
    await page.getByRole('tab', { name: 'Come è stato avviato' }).click();
    await expect(page.getByText('Comandi del modello')).toBeVisible();
    await expect(page.getByText(/^Usa i comandi «Qwen3-0\.6B-Q4_K_M»: YaRN 300K/)).toBeVisible();
    await page.getByRole('button', { name: 'Mostra comando' }).click();
    const command = page.getByRole('region', { name: 'Comando' });
    await expect(command).toContainText('-c 307200');
    await expect(command).toContainText('--rope-scaling yarn');
    await expect(command).toContainText('--rope-scale');
    await expect(command).toContainText('--yarn-orig-ctx 40960');
    await scan(page, 'result with the model commands');
  } finally {
    await gb.close();
  }
});

test('commands written by hand: "Avvia server" starts the model with them', async () => {
  const gb = await launchApp({ env: FAST_ENGINE });
  try {
    const { page } = gb;
    await skipWelcome(page);
    await openPage(page, 'Modelli');
    await page.getByRole('button', { name: 'Comandi per Qwen3-0.6B-Q4_K_M' }).click();
    const section = page.getByRole('dialog', { name: /^Comandi per questo modello/ });
    await section.getByRole('button', { name: 'Scrivi i comandi' }).click();
    const editor = page.getByRole('dialog', { name: 'Scrivi i comandi per Qwen3-0.6B-Q4_K_M' });
    await editor.getByLabel('Nome').fill('Qwen piccolo · jinja');
    await editor.getByRole('radio', { name: 'Un valore preciso' }).click();
    await editor.getByLabel('Contesto (token)').fill('16384');
    await editor.getByLabel('Argomenti in più · llama.cpp').fill('--jinja');
    await editor.getByLabel('Variabili d’ambiente').fill('GGML_E2E=1');
    await expect(editor.getByRole('region', { name: 'Comando completo' })).toContainText('--jinja', { timeout: 30_000 });
    await editor.getByRole('button', { name: 'Salva' }).click();
    await expect(section.getByText('Ricetta «Qwen piccolo · jinja»')).toBeVisible();
    await section.getByRole('button', { name: 'Chiudi' }).click();

    // "Avvia server" opens "Avvia un server": the model's commands are on (the chip) and in the exact command.
    await page.getByRole('button', { name: /^Avvia server: Qwen3/ }).click();
    await expect(h1(page, 'Avvia un server')).toBeVisible();
    await expect(page.getByRole('switch', { name: 'Usa i comandi di questo modello' })).toBeChecked();
    const command = page.getByRole('region', { name: 'Comando esatto' });
    await expect(command).toContainText('-c 16384', { timeout: 30_000 });
    await expect(command).toContainText('--jinja');
    await expect(page.getByText(/^Usa i comandi «Qwen piccolo · jinja»/)).toBeVisible();
    await page.getByRole('button', { name: /^(Avvia|Scarica e avvia)$/ }).click();
    const running = page.getByRole('region', { name: /^Server .* sulla porta \d+$/ });
    await expect(running.getByText('Acceso', { exact: true })).toBeVisible({ timeout: 90_000 });
    await expect(running.getByText('16.384', { exact: true })).toBeVisible();
    await running.getByRole('button', { name: /^Ferma il server / }).click();
    await expect(page.getByText('Nessun server acceso')).toBeVisible();
  } finally {
    await gb.close();
  }
});

test('a Bonsai model: the PrismML recipe with no fork set up leads to the Engines page, filled in for it', async () => {
  const userData = mkdtempSync(path.join(os.tmpdir(), 'gpubench-e2e-bonsai-'));
  const models = path.join(userData, 'models', 'local');
  mkdirSync(models, { recursive: true });
  writeFileSync(path.join(models, 'Ternary-Bonsai-8B-PQ2_0.gguf'), buildGguf({ ...llamaLikeGguf({ name: 'Ternary Bonsai 8B', sizeLabel: '8B' }), totalSize: 64 * 1024 }));
  const gb = await launchApp({ userData });
  try {
    const { page } = gb;
    await skipWelcome(page);
    await openPage(page, 'Modelli');
    await page.getByRole('button', { name: 'Comandi per Ternary-Bonsai-8B-PQ2_0' }).click();
    const section = page.getByRole('dialog', { name: /^Comandi per questo modello · Ternary-Bonsai/ });
    await section.getByRole('button', { name: 'Scegli da una ricetta pronta' }).click();
    const library = page.getByRole('dialog', { name: 'Ricette pronte' });
    await expect(library.getByText('Non hai ancora indicato dove si trova il fork sul tuo PC.')).toBeVisible();
    await library.getByRole('button', { name: 'Usa: Fork PrismML per modelli Bonsai' }).click();
    const editor = page.getByRole('dialog', { name: 'Scrivi i comandi per Ternary-Bonsai-8B-PQ2_0' });
    await editor.getByRole('button', { name: 'Salva' }).click();
    await expect(section.getByText('Manca il motore di questi comandi')).toBeVisible();
    await scan(page, 'recipe whose fork is missing');
    await section.getByRole('button', { name: 'Indica dove si trova il fork' }).click();
    // The Engines page's "Aggiungi motore", filled from the PrismML template for this model.
    const add = page.getByRole('dialog', { name: 'Aggiungi un motore' });
    await expect(add.getByText('Serve per Ternary-Bonsai-8B-PQ2_0')).toBeVisible({ timeout: 30_000 });
    await expect(add.getByLabel('Nome')).toHaveValue('Fork PrismML di llama.cpp');
  } finally {
    await gb.close();
    rmSync(userData, { recursive: true, force: true });
  }
});
