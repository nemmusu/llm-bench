import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, launchApp, test } from '../fixtures';
import { h1, openPage, scan, startLibraryWorld, stubDesktop, type LibraryWorld } from './library-helpers';

test.describe.configure({ timeout: 120_000 });

let world: LibraryWorld;

test.beforeAll(async () => {
  world = await startLibraryWorld();
});

test.afterAll(async () => {
  await world.close();
});

test('first launch on an empty PC: install llama.cpp with one click, download the recommended model, finish', async () => {
  const gb = await launchApp({ seedModel: false, env: world.env });
  try {
    const { page, userData } = gb;
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await stubDesktop(gb);
    await expect(h1(page, 'Benvenuto in LLM Bench')).toBeVisible();

    // Step 1: the system check, one traffic light per item.
    const check = page.getByRole('region', { name: 'Controllo del sistema' });
    await expect(check.getByText('Versione 617.14 · CUDA 13.4')).toBeVisible({ timeout: 20_000 });
    await expect(check.getByText('NVIDIA GeForce RTX 5090 · 32 GB')).toBeVisible();
    await expect(check.getByText('Mancano ancora 2 cose: premi il pulsante accanto a ciascuna, al resto penso io.')).toBeVisible();
    await scan(page, 'welcome check');

    // One button installs llama.cpp (download, extract, test start) and the check updates by itself.
    await check.getByRole('button', { name: /^Installa · .* \(Motore llama\.cpp\)$/ }).click();
    await expect(check.getByText(/^Versione b\d+ · /)).toBeVisible({ timeout: 60_000 });
    await expect(check.getByText('Manca ancora una cosa: premi il pulsante accanto, al resto penso io.')).toBeVisible();

    // "Scegli un modello" leads to the recommended setup.
    await check.getByRole('button', { name: 'Scegli un modello (Modelli)' }).click();
    const setup = page.getByRole('region', { name: 'Configurazione consigliata' });
    await expect(setup.getByText(/^llama\.cpp b\d+$/)).toBeVisible();
    await expect(setup.getByText('Qwen3 4B · Q4_K_M · 2,3 GB')).toBeVisible();
    await expect(setup.getByText('Entra perfettamente')).toBeVisible({ timeout: 20_000 });
    await scan(page, 'welcome setup');

    // Download with a clear confirmation: size, free space, destination.
    await setup.getByRole('button', { name: 'Scarica · 2,3 GB' }).click();
    const confirm = page.getByRole('dialog', { name: 'Scaricare Qwen3 4B · Q4_K_M?' });
    await expect(confirm.getByText(path.join(userData, 'models', 'Qwen', 'Qwen3-4B-GGUF'))).toBeVisible();
    await scan(page, 'download confirmation');
    await confirm.getByRole('button', { name: 'Scarica · 2,3 GB' }).click();
    await expect(page.getByText('Download completato: Qwen3 4B · Q4_K_M')).toBeVisible({ timeout: 30_000 });
    // Once on the PC, the recommendation is the local copy.
    await expect(setup.getByText('È già sul tuo PC: il test parte subito, senza scaricare nulla.')).toBeVisible();

    await page.getByRole('button', { name: 'Usa questa configurazione' }).click();
    await expect(page.getByRole('heading', { name: 'Tutto pronto!' })).toBeVisible();
    await scan(page, 'welcome done');
    await page.getByRole('button', { name: 'Vai al Benchmark' }).click();
    await expect(h1(page, 'Benchmark')).toBeVisible();

    const settings = JSON.parse(readFileSync(path.join(userData, 'settings.json'), 'utf8')) as Record<string, unknown>;
    expect(settings).toMatchObject({ onboardingDone: true, lastEngine: { kind: 'llamacpp-native' }, lastProfile: 'quick' });
    expect(typeof settings.lastModelId).toBe('string');

    // The model is in the library, the engine in Motori.
    await openPage(page, 'Modelli');
    await expect(page.getByText('Qwen3-4B-Q4_K_M', { exact: false }).first()).toBeVisible();
    await openPage(page, 'Motori');
    await expect(page.getByRole('list', { name: 'Versioni installate' }).getByText('In uso')).toBeVisible();
    // Checked against the releases like every other engine: the one just installed is the newest.
    await expect(page.getByRole('region', { name: 'llama.cpp' }).getByText('Hai l’ultima versione (b11438)')).toBeVisible({ timeout: 20_000 });
    await scan(page, 'engines');
    await page.getByRole('button', { name: 'Scegli versione…' }).click();
    const releases = page.getByRole('dialog', { name: 'Versioni di llama.cpp' });
    await expect(releases.getByRole('button', { name: /^Installa b\d+$/ }).first()).toBeVisible({ timeout: 20_000 });
    await scan(page, 'llama.cpp releases');
    await releases.getByRole('button', { name: 'Chiudi' }).click();
    await expect(releases).toBeHidden();
  } finally {
    await gb.close();
  }
});

test('the wizard can be skipped and the check opened later from Motori', async () => {
  const gb = await launchApp({ env: world.env });
  try {
    const { page } = gb;
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.getByRole('button', { name: 'Salta, lo farò dopo' }).click();
    await expect(h1(page, 'Benchmark')).toBeVisible();
    await openPage(page, 'Motori');
    const check = page.getByRole('region', { name: 'Controllo del sistema' });
    await expect(check.getByText('1 modello sul tuo PC')).toBeVisible({ timeout: 20_000 });
    await check.getByRole('button', { name: 'Ricontrolla' }).click();
    await expect(check.getByText('Driver NVIDIA')).toBeVisible();
  } finally {
    await gb.close();
  }
});
