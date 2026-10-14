/**
 * A GGUF-NInfer model like the user's, on Windows (inside WSL) or on Linux (on this PC):
 *  1. ~/ninfer-all already cloned, its first configure refused by NInfer-all's own check (CUDA 13.0):
 *     the model says it works with NInfer-all, the card says "Da compilare"; "Avvia benchmark" asks for
 *     NInfer-all, says CUDA is too old with the exact `sudo apt install`; once 13.3 is there,
 *     "Ricontrolla", then it is built in place (the old CMake cache cleared, the new nvcc named) and the
 *     test starts by itself on NInfer-all, with the model card's settings;
 *  2. a model whose manifest cannot be read, on the official NInfer: its first launch stops, says why and
 *     offers "Riprova con NInfer-all" (built by hand in ~/ninfer-all: found and taken as it is), which works.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildNinfer } from '../../fakes/fake-hub/model-files.mjs';
import { expect, launchApp, test } from '../fixtures';
import { h1, scan, skipWelcome } from './bench-helpers';
import { openPage } from './library-helpers';
import { changeHost, chooseNinfer, ninferCard, ninferEnv, OFFICIAL_SAVED, WHERE } from './ninfer-helpers';

test.describe.configure({ timeout: 240_000 });

const MODEL = 'Qwen3.8-27B-Coder390-EfficientThink-Q6_K-MTP';
const ALL = 'https://github.com/iamwavecut/ninfer-all.git';
const NVCC_13_0 = { path: '/usr/local/cuda-13.0/bin/nvcc', version: '13.0' };
const NVCC_13_3 = { path: '/usr/local/cuda-13.3/bin/nvcc', version: '13.3' };
/** The model card's settings (KV as large as fits for 4 users of 100K) fit this pretend card. */
const PROFILE = JSON.stringify({ loadMsWarm: 300, prefillTps: 20_000, decodeTps: 900, tokensPerChunk: 2, ninfer: { freeMiB: 60_000 } });

/** The user's artifact: no manifest next to it, its own at its start (GGUF blocks), in the "GGUF-NInfer" folder of its repo. */
function seedGgufNinfer(modelsDir: string): void {
  const dir = path.join(modelsDir, 'nerkyor', 'Qwen3.8-27B-Coder390-EfficientThink-GGUF-NInfer', 'GGUF-NInfer');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, `${MODEL}.ninfer`),
    buildNinfer({ name: 'qwen3.8-27b-coder390-q6k-mtp', components: ['text', 'mtp', 'vision'], layouts: ['contiguous_le_v1', 'gguf_blocks_v1', 'row_split_k128_v1'], totalSize: 65_536 }),
  );
}

test("the user's GGUF-NInfer model: NInfer-all needs CUDA 13.1, the apt line, then it is built in place and the test runs on it by itself", async () => {
  const userData = mkdtempSync(path.join(os.tmpdir(), 'gpubench-e2e-ninfer-all-'));
  seedGgufNinfer(path.join(userData, 'models'));
  const gb = await launchApp({
    userData,
    settings: { ninfer: OFFICIAL_SAVED },
    env: {
      ...ninferEnv(userData, {
        checkouts: ['/home/user/ninfer', '/home/user/ninfer-all'],
        origins: { '/home/user/ninfer-all': ALL },
        nvccs: [NVCC_13_0],
        aptCuda: ['cuda-toolkit-13-1', 'cuda-toolkit-13-2', 'cuda-toolkit-13-3'],
        // Its first configure, refused: only CMake's cache, made with CUDA 13.0.
        caches: { '/home/user/ninfer-all': { nvcc: NVCC_13_0.path, configured: false } },
      }),
      FAKE_ENGINE_PROFILE: PROFILE,
    },
  });
  try {
    const { page } = gb;
    await skipWelcome(page);

    // Models: read from its own manifest, it says which NInfer reads it.
    await openPage(page, 'Modelli');
    const list = page.getByRole('list', { name: 'Per NInfer (RTX 5090)' });
    await expect(list.getByText(MODEL, { exact: true })).toBeVisible({ timeout: 20_000 });
    await expect(list.getByRole('link', { name: /Funziona con NInfer-all/ })).toBeVisible();

    // Motori: the clone is there, not built yet.
    await openPage(page, 'Motori');
    const { official, all } = ninferCard(page);
    await expect(official.getByText('Pronto')).toBeVisible({ timeout: 20_000 });
    await expect(all.getByText('Da compilare')).toBeVisible({ timeout: 20_000 });
    await expect(all.getByText(/Il codice \(commit e31bc99\) è nella cartella ma il programma no/)).toBeVisible();
    await scan(page, 'NInfer-all to build');

    // Benchmark: NInfer runs this model with NInfer-all, from the model card's settings.
    await openPage(page, 'Benchmark');
    await chooseNinfer(page);
    // Named as its manifest names it.
    await expect(page.getByRole('button', { name: /Cambia modello: qwen3.8-27b-coder390-q6k-mtp/ })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText('Serve NInfer-all: lo compilo prima del test')).toBeVisible({ timeout: 20_000 });
    const settings = page.getByRole('radiogroup', { name: 'Impostazioni di NInfer' });
    await expect(settings.getByRole('radio', { name: /Consigliata dalla scheda del modello: 100K per richiesta, KV rk8v4 condivisa, quanta ne entra, 4 utenti, MTP 3/ })).toBeChecked();
    await page.getByRole('radio', { name: /Rapido/ }).click();
    await page.getByRole('button', { name: 'Avvia benchmark' }).click();

    // What is missing first: CUDA 13.0 is too old for NInfer-all; the line to copy.
    const gate = page.getByRole('dialog', { name: 'Questo modello funziona solo con NInfer-all' });
    await expect(gate.getByText(`Prima serve qualcosa ${WHERE}: ecco cosa manca e il comando da copiare. Poi premi Ricontrolla.`)).toBeVisible({ timeout: 30_000 });
    await expect(gate.getByRole('region', { name: 'Comando da copiare' })).toContainText('sudo apt install cuda-toolkit-13-3');
    await expect(gate.getByText(/con il CUDA che c’è \(13\.0\) compilerebbe male i suoi kernel/)).toBeVisible();
    await scan(page, 'NInfer-all needs CUDA 13.1');
    // The user runs it; "Ricontrolla": the clone is built where it is.
    changeHost(userData, { nvccs: [NVCC_13_0, NVCC_13_3] });
    await gate.getByRole('button', { name: 'Ricontrolla' }).click();
    await expect(gate.getByText(`C’è già una copia: la compilo io ${WHERE} (circa 29 min), senza riscaricarla. Poi riparto da solo.`)).toBeVisible({ timeout: 30_000 });
    await gate.getByText('Avanzate').click();
    const commands = gate.getByRole('region', { name: 'Comandi che eseguirò' });
    await expect(commands).toContainText('rm -rf -- /home/user/ninfer-all/build/CMakeCache.txt /home/user/ninfer-all/build/CMakeFiles');
    await expect(commands).toContainText('-DCMAKE_CUDA_COMPILER=/usr/local/cuda-13.3/bin/nvcc');
    await scan(page, 'build NInfer-all');
    await gate.getByRole('button', { name: 'Compila', exact: true }).click();

    // Built, then the test by itself, on NInfer-all.
    await expect(h1(page, /coder390/i)).toBeVisible({ timeout: 120_000 });
    await expect(page.getByText('Completato', { exact: true })).toBeVisible({ timeout: 120_000 });
    await page.getByRole('tab', { name: 'Come è stato avviato' }).click();
    await page.getByRole('button', { name: 'Mostra comando' }).click();
    const command = page.getByRole('region', { name: 'Comando' });
    await expect(command).toContainText('/home/user/ninfer-all/build/apps/ninfer-serve');
    await expect(command).toContainText('--kv-capacity auto');
    await expect(command).toContainText('--kv-dtype rk8v4');

    // The card: NInfer-all ready, its version from the program itself.
    await openPage(page, 'Motori');
    await expect(all.getByText('Pronto')).toBeVisible({ timeout: 20_000 });
    await expect(all.getByText('0.12.0-rtx3090+v0.6.0-rtx3090-1704-ge7b7e669')).toBeVisible();
  } finally {
    await gb.close();
    rmSync(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test('a model whose manifest cannot be read on the official NInfer: its first launch stops and says why; "Riprova con NInfer-all" (built by hand) works', async () => {
  const userData = mkdtempSync(path.join(os.tmpdir(), 'gpubench-e2e-ninfer-unread-'));
  // Renamed, no manifest anywhere: only its blocks (the fake reads "gguf" in its path as GGUF's blocks).
  const dir = path.join(userData, 'models', 'local', 'my-gguf-model');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'coder-q6k.ninfer'), Buffer.alloc(65_536));
  const gb = await launchApp({
    userData,
    settings: { ninfer: OFFICIAL_SAVED },
    env: {
      ...ninferEnv(userData, {
        checkouts: ['/home/user/ninfer', '/home/user/ninfer-all'],
        origins: { '/home/user/ninfer-all': ALL },
        builds: ['/home/user/ninfer/build/apps/ninfer-serve', '/home/user/ninfer-all/build/apps/ninfer-serve'],
      }),
      FAKE_ENGINE_PROFILE: PROFILE,
    },
  });
  try {
    const { page } = gb;
    await skipWelcome(page);
    await openPage(page, 'Benchmark');
    await chooseNinfer(page);
    await expect(page.getByRole('button', { name: /Cambia modello: coder-q6k/ })).toBeVisible({ timeout: 20_000 });
    await page.getByRole('radio', { name: /Rapido/ }).click();
    await page.getByRole('button', { name: 'Avvia benchmark' }).click();
    await expect(h1(page, /coder-q6k/)).toBeVisible({ timeout: 90_000 });
    const card = page.getByRole('alert');
    await expect(card.getByRole('heading', { name: 'Questa versione del motore non sa leggere il modello' })).toBeVisible({ timeout: 30_000 });
    await expect(card.getByText(/Il NInfer ufficiale non sa leggere il formato gguf_blocks_v1 di questo modello, nemmeno aggiornato/)).toBeVisible();
    // An update of NInfer would never read it: not offered.
    await expect(card.getByRole('button', { name: 'Aggiorna NInfer' })).toHaveCount(0);
    await scan(page, 'model the engine cannot read');
    await card.getByRole('button', { name: 'Riprova con NInfer-all' }).click();
    await expect(page.getByText('Completato', { exact: true })).toBeVisible({ timeout: 120_000 });
    await page.getByRole('tab', { name: 'Come è stato avviato' }).click();
    await page.getByRole('button', { name: 'Mostra comando' }).click();
    await expect(page.getByRole('region', { name: 'Comando' })).toContainText('/home/user/ninfer-all/build/apps/ninfer-serve');
  } finally {
    await gb.close();
    rmSync(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test('NInfer-all opened from its model: the card scrolls to it, says what it is for, and builds it from scratch', async () => {
  const userData = mkdtempSync(path.join(os.tmpdir(), 'gpubench-e2e-ninfer-all-new-'));
  seedGgufNinfer(path.join(userData, 'models'));
  const gb = await launchApp({ userData, settings: { ninfer: OFFICIAL_SAVED }, env: ninferEnv(userData) });
  try {
    const { page } = gb;
    await skipWelcome(page);
    await openPage(page, 'Modelli');
    await page.getByRole('link', { name: /Funziona con NInfer-all/ }).first().click();
    const { all } = ninferCard(page);
    await expect(all.getByText(`Serve per ${MODEL}.`)).toBeVisible({ timeout: 20_000 });
    await expect(all.getByText('Non installato')).toBeVisible();
    await all.getByRole('button', { name: 'Scarica e compila' }).click();
    await expect(page.getByText('NInfer-all è pronto.')).toBeVisible({ timeout: 60_000 });
    await expect(all.getByText('Pronto')).toBeVisible({ timeout: 30_000 });
  } finally {
    await gb.close();
    rmSync(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
