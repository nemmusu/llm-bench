/**
 * A GGUF-NInfer artifact like a person on Windows (a fake wsl.exe whose distro runs the fake ninfer-serve):
 *  1. with the official NInfer, "Trova le impostazioni migliori" stops at its first launch and says why:
 *     this NInfer cannot read the format gguf_blocks_v1, NInfer-all can ("Aggiungi NInfer-all");
 *  2. "Aggiungi NInfer-all": downloaded from its repository and built inside the distro (the exact commands,
 *     its size, the time), saved as a custom engine by itself;
 *  3. the Benchmark proposes it for the model, with the model card's settings; a Rapido test works.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, launchApp, ROOT, test } from '../fixtures';
import { h1, scan, skipWelcome } from './bench-helpers';
import { openPage } from './library-helpers';

test.describe.configure({ timeout: 240_000 });

const MODEL = 'Qwen3.8-27B-Coder390-EfficientThink-Q6_K-MTP';

/** The user's artifact: no manifest next to it, in the "GGUF-NInfer" folder of its repo. */
function seedGgufNinfer(modelsDir: string): void {
  const dir = path.join(modelsDir, 'nerkyor', 'Qwen3.8-27B-Coder390-EfficientThink-GGUF-NInfer', 'GGUF-NInfer');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `${MODEL}.ninfer`), Buffer.alloc(65_536));
}

test('a GGUF-NInfer model: the official NInfer says it cannot read it, NInfer-all is added for it and runs it', async () => {
  const userData = mkdtempSync(path.join(os.tmpdir(), 'gpubench-e2e-ninfer-all-'));
  seedGgufNinfer(path.join(userData, 'models'));
  const gb = await launchApp({
    userData,
    settings: { ninfer: { wsl: { distro: 'Ubuntu-24.04', path: '/home/user/ninfer' } } },
    env: {
      GPUBENCH_WSL: JSON.stringify([process.execPath, path.join(ROOT, 'test', 'fakes', 'fake-wsl', 'fake-wsl.mjs')]),
      FAKE_WSL_STATE: path.join(userData, 'fake-wsl'),
      // The model card's settings (409,600 tokens of rk8v4 KV for 4 users) fit this pretend card.
      FAKE_ENGINE_PROFILE: JSON.stringify({ loadMsWarm: 300, prefillTps: 20_000, decodeTps: 900, tokensPerChunk: 2, ninfer: { freeMiB: 60_000 } }),
    },
  });
  try {
    const { page } = gb;
    await skipWelcome(page);

    // Models: recognised without its manifest, and it says which NInfer it needs.
    await openPage(page, 'Modelli');
    const list = page.getByRole('list', { name: 'Per NInfer (RTX 5090)' });
    await expect(list.getByText(MODEL, { exact: true })).toBeVisible({ timeout: 20_000 });
    await expect(list.getByText('senza manifest')).toBeVisible();
    await expect(list.getByRole('link', { name: /Richiede NInfer-all/ })).toBeVisible();

    // 1. The official NInfer, "Trova le impostazioni migliori": the first launch fails, the run ends there.
    await openPage(page, 'Benchmark');
    await page.getByRole('combobox', { name: 'Cambia motore' }).click();
    await page.getByRole('option', { name: /^NInfer \(WSL\)/ }).first().click();
    await expect(page.getByRole('button', { name: new RegExp(`Cambia modello: ${MODEL}`) })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText('Questo modello richiede NInfer-all')).toBeVisible();
    await page.getByRole('radio', { name: /Trova le impostazioni migliori/ }).click();
    await page.getByRole('button', { name: 'Avvia benchmark' }).click();
    await expect(h1(page, new RegExp(MODEL))).toBeVisible({ timeout: 90_000 });
    const card = page.getByRole('alert');
    await expect(card.getByRole('heading', { name: 'Questa versione del motore non sa leggere il modello' })).toBeVisible();
    await expect(card.getByText('Questo modello usa un formato (gguf_blocks_v1) che questa versione di NInfer non sa leggere. Serve una variante di NInfer che lo supporti, come NInfer-all.')).toBeVisible();
    await expect(card.getByRole('button', { name: 'Aggiorna NInfer' })).toBeVisible();
    await scan(page, 'model the engine cannot read');

    // 2. "Aggiungi NInfer-all": its template, for this model; downloaded and built inside the distro.
    await card.getByRole('button', { name: 'Aggiungi NInfer-all' }).click();
    const dialog = page.getByRole('dialog', { name: 'Aggiungi un motore' });
    await expect(dialog.getByText(new RegExp(`Serve per ${MODEL}`))).toBeVisible({ timeout: 20_000 });
    await expect(dialog.getByLabel('Repository git')).toHaveValue('https://github.com/iamwavecut/ninfer-all.git');
    await expect(dialog.getByRole('combobox', { name: 'Distribuzione WSL' })).toContainText('Ubuntu-24.04');
    await scan(page, 'add NInfer-all');
    await dialog.getByRole('button', { name: 'Scarica e compila NInfer-all' }).click();
    const build = page.getByRole('dialog', { name: 'Scarica e compila NInfer-all' });
    await expect(build.getByText('Da scaricare: circa 38,4 MB.')).toBeVisible({ timeout: 30_000 });
    await expect(build.getByText('Compilazione: circa 10 minuti con 16 core.')).toBeVisible();
    await expect(build.getByRole('region', { name: 'Comandi che eseguirò' })).toContainText('git clone --progress --branch master https://github.com/iamwavecut/ninfer-all.git /home/user/ninfer-all');
    await expect(build.getByRole('region', { name: 'Comandi che eseguirò' })).toContainText('-DCMAKE_CUDA_ARCHITECTURES=120a');
    await scan(page, 'build NInfer-all');
    await build.getByRole('button', { name: 'Scarica e compila' }).click();
    await expect(page.getByText('NInfer-all è pronto: lo trovi tra i motori personalizzati.')).toBeVisible({ timeout: 60_000 });
    const saved = page.getByRole('region', { name: 'NInfer-all', exact: true });
    await expect(saved.getByText('Pronto')).toBeVisible({ timeout: 30_000 });
    await expect(saved.getByText(/Cache KV che conosce: .*rk8v4/)).toBeVisible();
    await expect(saved.getByText('/home/user/ninfer-all/build/apps/ninfer-serve · Ubuntu-24.04')).toBeVisible();
    // The official NInfer is still where it was.
    await expect(page.getByRole('region', { name: 'NInfer', exact: true }).getByText('/home/user/ninfer/build/apps/ninfer-serve')).toBeVisible();

    // 3. The Benchmark proposes it; it starts from the model card's settings; a Rapido test works.
    await openPage(page, 'Benchmark');
    await expect(page.getByText('Per questo modello c’è NInfer-all')).toBeVisible({ timeout: 20_000 });
    await page.getByRole('button', { name: 'Usa NInfer-all' }).click();
    const settings = page.getByRole('radiogroup', { name: 'Impostazioni di NInfer' });
    await expect(settings.getByRole('radio', { name: /Consigliata dalla scheda del modello: 100K per richiesta, KV rk8v4 condivisa da 400K, 4 utenti, MTP 3/ })).toBeChecked();
    await page.getByRole('radio', { name: /Rapido/ }).click();
    await page.getByRole('button', { name: /Anteprima comando/ }).click();
    const preview = page.getByRole('region', { name: 'Anteprima comando' });
    await expect(preview).toContainText('/home/user/ninfer-all/build/apps/ninfer-serve', { timeout: 20_000 });
    await expect(preview).toContainText('--kv-dtype rk8v4');
    await scan(page, 'benchmark with NInfer-all');
    await page.getByRole('button', { name: 'Avvia benchmark' }).click();
    await expect(h1(page, new RegExp(MODEL))).toBeVisible({ timeout: 120_000 });
    await expect(page.getByText('Completato', { exact: true })).toBeVisible();
    await expect(page.getByText(/NInfer-all/).first()).toBeVisible();
  } finally {
    await gb.close();
    rmSync(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
