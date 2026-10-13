/**
 * Custom engines and SGLang, as a person meets them: a llama.cpp fork added on the Engines page (the
 * fake engine in fork mode: it lacks -ub and has an extra option) and benchmarked; SGLang in Docker
 * (the fake docker CLI runs the fake engine in SGLang mode); a program with an OpenAI API started from
 * a command template, measured and stopped.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { expect, launchApp, ROOT, test } from '../fixtures';
import { h1, scan, skipWelcome } from './bench-helpers';
import { openPage, startLibraryWorld, stubDesktop, type LibraryWorld } from './library-helpers';

test.describe.configure({ timeout: 180_000 });

const FORK = path.join(ROOT, 'test', 'fakes', 'fake-engine', 'fork.mjs');
const CLI = path.join(ROOT, 'test', 'fakes', 'fake-engine', 'cli.mjs');

let world: LibraryWorld;

test.beforeAll(async () => {
  world = await startLibraryWorld();
});

test.afterAll(async () => {
  await world.close();
});

/** A run that finished: the result page opens by itself. */
async function waitForResult(page: Page, model: RegExp): Promise<void> {
  await expect(h1(page, 'Test in corso')).toBeVisible({ timeout: 60_000 });
  await expect(h1(page, model)).toBeVisible({ timeout: 120_000 });
  await expect(page.getByText('Completato', { exact: true })).toBeVisible();
}

test('a llama.cpp fork: added with its check, the flag it lacks said in words, then benchmarked', async () => {
  const gb = await launchApp({ env: world.env });
  try {
    const { page } = gb;
    await skipWelcome(page);
    await stubDesktop(gb, FORK);
    await openPage(page, 'Motori');
    await expect(page.getByText('Nessun motore personalizzato')).toBeVisible();
    await page.getByRole('button', { name: 'Aggiungi motore' }).click();
    const dialog = page.getByRole('dialog', { name: 'Aggiungi un motore' });
    await dialog.getByRole('radio', { name: /Fork di llama\.cpp/ }).click();
    await scan(page, 'add engine: kind');
    await dialog.getByRole('button', { name: 'Avanti' }).click();
    await dialog.getByLabel('Nome').fill('PrismML');
    await dialog.getByRole('button', { name: 'Scegli file…' }).click();
    await expect(dialog.getByLabel('Il programma llama-server')).toHaveValue(FORK);
    await dialog.getByRole('button', { name: 'Prova' }).click();
    await expect(dialog.getByText('Funziona · versione b7001')).toBeVisible({ timeout: 30_000 });
    await expect(dialog.getByText('Non conosce -ub (l’ubatch): userò il suo valore predefinito.')).toBeVisible();
    await scan(page, 'add engine: check');
    await dialog.getByRole('button', { name: 'Avanti' }).click();
    // The fork's own option, on every launch.
    await dialog.getByLabel('Argomenti in più').fill('--ternary-kernels on');
    await dialog.getByLabel('Parole nel nome del modello').fill('qwen3');
    await dialog.getByRole('button', { name: 'Salva motore' }).click();
    await expect(dialog).toBeHidden();

    const card = page.getByRole('region', { name: 'PrismML' });
    await expect(card.getByText('Funziona come llama.cpp')).toBeVisible();
    await expect(card.getByText('Questo motore non conosce alcune impostazioni di GPU Bench')).toBeVisible({ timeout: 30_000 });
    await scan(page, 'custom engines');
    await card.getByRole('button', { name: 'Usa nel Benchmark' }).click();

    // The Benchmark: the fork is chosen, nothing to install; ubatch asked in expert mode is left out and said.
    await expect(h1(page, 'Benchmark')).toBeVisible();
    await expect(page.getByRole('combobox', { name: 'Cambia motore' })).toContainText('llama.cpp · PrismML');
    await page.getByRole('switch', { name: 'Modalità esperto' }).click();
    await expect(page.getByText('Usi il motore personalizzato PrismML: eseguibile, immagine e argomenti si cambiano nella pagina Motori.')).toBeVisible();
    await page.getByLabel('Micro-batch').fill('1024');
    await expect(page.getByText('Il motore non conosce alcune impostazioni').first()).toBeVisible({ timeout: 30_000 });
    // Expert mode shows the exact command already.
    const command = page.getByRole('region', { name: 'Anteprima comando' });
    await expect(command).toContainText('--ternary-kernels on');
    await expect(command).not.toContainText('-ub ');
    await scan(page, 'benchmark with a fork');
    await page.getByRole('button', { name: 'Avvia benchmark' }).click();
    await waitForResult(page, /Qwen3-0\.6B-Q4_K_M/);
    await expect(page.getByText(/PrismML b7001/).first()).toBeVisible();
    await scan(page, 'result of a fork');
  } finally {
    await gb.close();
  }
});

test('SGLang in Docker: pulled before the run, benchmarked like vLLM', async () => {
  // A safetensors checkpoint in the library (SGLang reads models like vLLM).
  const userData = mkdtempSync(path.join(os.tmpdir(), 'gpubench-e2e-sglang-'));
  const dir = path.join(userData, 'models', 'local', 'Qwen3-0.6B-FP8');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, 'config.json'),
    JSON.stringify({ architectures: ['Qwen3ForCausalLM'], num_hidden_layers: 28, hidden_size: 1024, num_attention_heads: 16, num_key_value_heads: 8, max_position_embeddings: 40960, quantization_config: { quant_method: 'fp8' } }),
  );
  writeFileSync(path.join(dir, 'model.safetensors'), Buffer.alloc(4096));
  const gb = await launchApp({ env: world.env, userData });
  try {
    const { page } = gb;
    await skipWelcome(page);
    await openPage(page, 'Motori');
    const card = page.getByRole('region', { name: 'SGLang (Docker)' });
    const tags = card.getByRole('list', { name: 'Versioni di SGLang' });
    await expect(tags.getByText('Consigliato')).toBeVisible({ timeout: 30_000 });
    await scan(page, 'sglang card');

    await openPage(page, 'Benchmark');
    await page.getByRole('combobox', { name: 'Cambia motore' }).click();
    await page.getByRole('option', { name: /^SGLang \(Docker\)/ }).click();
    await expect(page.getByRole('button', { name: /Cambia modello: .*Qwen3-0\.6B-FP8/ })).toBeVisible({ timeout: 30_000 });
    await page.getByRole('button', { name: 'Avvia benchmark' }).click();
    const confirm = page.getByRole('dialog', { name: 'Prima di iniziare scarico quello che manca' });
    await expect(confirm.getByText(/lmsysorg\/sglang:v0\.5\.21/)).toBeVisible({ timeout: 30_000 });
    await confirm.getByRole('button', { name: 'Scarica e avvia' }).click();
    await waitForResult(page, /Qwen3-0\.6B-FP8/);
    await expect(page.getByText(/SGLang v0\.5\.21/).first()).toBeVisible();
    await page.getByRole('tab', { name: 'Come è stato avviato' }).click();
    await page.getByRole('button', { name: 'Mostra comando' }).click();
    await expect(page.getByRole('region', { name: 'Comando' })).toContainText('sglang.launch_server');
    await scan(page, 'sglang result');
  } finally {
    await gb.close();
    rmSync(userData, { recursive: true, force: true });
  }
});

test('a program with an OpenAI API: started from its command, measured, stopped', async () => {
  const gb = await launchApp({ env: world.env });
  try {
    const { page } = gb;
    await skipWelcome(page);
    await openPage(page, 'Motori');
    await page.getByRole('button', { name: 'Aggiungi motore' }).click();
    const dialog = page.getByRole('dialog', { name: 'Aggiungi un motore' });
    await dialog.getByRole('radio', { name: /Programma con API OpenAI/ }).click();
    await dialog.getByRole('button', { name: 'Avanti' }).click();
    await dialog.getByLabel('Nome').fill('Il mio server');
    // The fake engine in vLLM mode stands in for the user's own program.
    await dialog.getByLabel('Comando che avvia il server').fill(`"${process.execPath}" "${CLI}" serve {model} --port {port} --served-model-name {alias} --max-model-len {ctx}`);
    await dialog.getByRole('button', { name: 'Prova' }).click();
    await expect(dialog.getByText(`Programma trovato: ${process.execPath}`)).toBeVisible({ timeout: 30_000 });
    await dialog.getByRole('button', { name: 'Avanti' }).click();
    await dialog.getByRole('button', { name: 'Salva motore' }).click();
    await expect(dialog).toBeHidden();
    await page.getByRole('region', { name: 'Il mio server' }).getByRole('button', { name: 'Usa nel Benchmark' }).click();

    await expect(h1(page, 'Benchmark')).toBeVisible();
    await expect(page.getByRole('combobox', { name: 'Cambia motore' })).toContainText('Programma con API OpenAI · Il mio server');
    // Nothing to search on a program of one's own.
    await expect(page.getByRole('radio', { name: /Trova le impostazioni migliori/ })).toHaveCount(0);
    await page.getByRole('button', { name: 'Avvia benchmark' }).click();
    await waitForResult(page, /Qwen3-0\.6B-Q4_K_M/);
    await expect(page.getByText(/Il mio server/).first()).toBeVisible();
    await scan(page, 'command engine result');
  } finally {
    await gb.close();
  }
});
