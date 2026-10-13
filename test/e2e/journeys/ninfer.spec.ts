/**
 * NInfer like a person on Windows: point GPU Bench at the build inside WSL (a fake wsl.exe whose
 * distro runs the fake ninfer-serve), pick the "Consigliata da NInfer" settings for a .ninfer model,
 * run a Rapido benchmark, then start a server with the same settings and stop it.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Locator, Page } from '@playwright/test';
import { expect, launchApp, ROOT, test } from '../fixtures';
import { h1, scan, skipWelcome } from './bench-helpers';
import { openPage } from './library-helpers';

test.describe.configure({ timeout: 180_000 });

const MANIFEST = {
  schema: 'ninfer.artifact-manifest',
  schema_version: 2,
  artifact: { filename: 'qwen3_8_27b_nvfp4.ninfer', bytes: 65_536, sha256: '74'.repeat(32), container_version: 3, architecture: 'Qwen3_5ForCausalLM', name: 'qwen3.8-27b', components: ['text', 'vision', 'mtp', 'dflash2'] },
};

/** A downloaded NInfer artifact in the library (the .ninfer file, its manifest and checksums). */
function seedNinfer(modelsDir: string, containerVersion = 3): void {
  const dir = path.join(modelsDir, 'neroued', 'Qwen3.8-27B-nvfp4-NInfer');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'qwen3_8_27b_nvfp4.ninfer'), Buffer.alloc(65_536));
  writeFileSync(path.join(dir, 'Qwen3.8-27B-nvfp4-NInfer.artifact-manifest.json'), JSON.stringify({ ...MANIFEST, artifact: { ...MANIFEST.artifact, container_version: containerVersion } }));
  writeFileSync(path.join(dir, 'Qwen3.8-27B-nvfp4-NInfer.SHA256SUMS'), `${'74'.repeat(32)}  qwen3_8_27b_nvfp4.ninfer\n`);
}

/** Points the NInfer card at the build in the fake distro (Ubuntu-24.04, /home/user/ninfer). */
async function useBuild(page: Page): Promise<Locator> {
  await openPage(page, 'Motori');
  const card = page.getByRole('region', { name: 'NInfer', exact: true });
  await expect(card.getByRole('combobox', { name: 'Distribuzione WSL' })).toContainText('Ubuntu-24.04', { timeout: 20_000 });
  await card.getByRole('textbox', { name: 'Dove si trova NInfer' }).fill('/home/user/ninfer');
  await card.getByRole('button', { name: 'Controlla e usa' }).click();
  await expect(card.getByText('Pronto')).toBeVisible({ timeout: 20_000 });
  return card;
}

test('NInfer through WSL: find the build, run a Rapido benchmark with its recommended settings, serve and stop', async () => {
  const userData = mkdtempSync(path.join(os.tmpdir(), 'gpubench-e2e-ninfer-'));
  seedNinfer(path.join(userData, 'models', 'local'));
  const gb = await launchApp({
    userData,
    env: {
      GPUBENCH_WSL: JSON.stringify([process.execPath, path.join(ROOT, 'test', 'fakes', 'fake-wsl', 'fake-wsl.mjs')]),
      FAKE_WSL_STATE: path.join(userData, 'fake-wsl'),
      FAKE_ENGINE_PROFILE: JSON.stringify({ loadMsWarm: 300, prefillTps: 20_000, decodeTps: 900, tokensPerChunk: 2 }),
    },
  });
  try {
    const { page } = gb;
    await skipWelcome(page);

    // Motori: NInfer is to be set up; its distro is read from WSL; the build is checked by running its help.
    await openPage(page, 'Motori');
    const card = page.getByRole('region', { name: 'NInfer', exact: true });
    await expect(card.getByText('solo RTX 5090 · Linux / WSL')).toBeVisible();
    await expect(card.getByText('Da configurare')).toBeVisible({ timeout: 20_000 });
    await expect(card.getByRole('combobox', { name: 'Distribuzione WSL' })).toContainText('Ubuntu-24.04');
    await card.getByRole('textbox', { name: 'Dove si trova NInfer' }).fill('/home/user/nowhere');
    await card.getByRole('button', { name: 'Controlla e usa' }).click();
    await expect(card.getByText('ninfer-serve non è qui: /home/user/nowhere/build/apps/ninfer-serve')).toBeVisible({ timeout: 20_000 });
    await card.getByRole('textbox', { name: 'Dove si trova NInfer' }).fill('/home/user/ninfer');
    await card.getByRole('button', { name: 'Controlla e usa' }).click();
    await expect(card.getByText('Pronto')).toBeVisible({ timeout: 20_000 });
    await expect(card.getByText('e31bc99b13f5')).toBeVisible();
    await expect(card.getByText('/home/user/ninfer/build/apps/ninfer-serve')).toBeVisible();
    await scan(page, 'NInfer card');

    // Benchmark: NInfer (WSL), the .ninfer model, NInfer's own recommended settings.
    await openPage(page, 'Benchmark');
    await page.getByRole('combobox', { name: 'Cambia motore' }).click();
    await page.getByRole('option', { name: /NInfer \(WSL\)/ }).click();
    await expect(page.getByRole('button', { name: /Cambia modello: qwen3.8-27b/ })).toBeVisible({ timeout: 20_000 });
    const settings = page.getByRole('radiogroup', { name: 'Impostazioni di NInfer' });
    await settings.getByRole('radio', { name: /Consigliata da NInfer: contesto 240K, KV fp8, 2 utenti, MTP 3/ }).click();
    await expect(settings.getByRole('radio', { name: /Provata su RTX 5090: 64K per richiesta, KV int8 condivisa da 128K, 2 utenti, visione, MTP 3/ })).toBeVisible();
    await page.getByRole('radio', { name: /Rapido/ }).click();
    await page.getByRole('button', { name: /Anteprima comando/ }).click();
    const preview = page.getByRole('region', { name: 'Anteprima comando' });
    await expect(preview).toContainText('--kv-dtype fp8', { timeout: 20_000 });
    await expect(preview).toContainText('--spec mtp --draft-tokens 3');
    await expect(preview).toContainText('--no-prefix-reuse');
    await expect(preview).toContainText('Ubuntu-24.04');
    await scan(page, 'benchmark with NInfer settings');

    await page.getByRole('button', { name: 'Avvia benchmark' }).click();
    await expect(h1(page, 'Test in corso')).toBeVisible({ timeout: 30_000 });
    await expect(h1(page, /qwen3_8_27b_nvfp4/)).toBeVisible({ timeout: 90_000 });
    await expect(page.getByText('Completato', { exact: true })).toBeVisible();
    const kpis = page.getByRole('region', { name: 'Numeri principali' });
    await expect(kpis.getByText('Generazione')).toBeVisible();
    await page.getByRole('tab', { name: 'Come è stato avviato' }).click();
    await page.getByRole('button', { name: 'Mostra comando' }).click();
    await expect(page.getByRole('region', { name: 'Comando' })).toContainText('ninfer-serve');
    await scan(page, 'NInfer result');

    // A server with the same settings from the Benchmark page, then stopped.
    await openPage(page, 'Benchmark');
    await page.getByRole('button', { name: 'Avvia solo il server', exact: true }).click();
    const confirm = page.getByRole('dialog', { name: 'Avvia il server' });
    const command = confirm.getByRole('region', { name: 'Comando esatto' });
    await expect(command).toContainText('--kv-capacity 240000', { timeout: 30_000 });
    await expect(command).not.toContainText('--no-prefix-reuse');
    await confirm.getByRole('button', { name: 'Avvia server' }).click();
    const ready = page.getByRole('dialog', { name: 'Il server è pronto' });
    await expect(ready.getByText('Indirizzo compatibile OpenAI')).toBeVisible({ timeout: 90_000 });
    const url = (await ready.getByText(/^http:\/\/127\.0\.0\.1:\d+\/v1$/).textContent())!;
    expect((await fetch(`${url}/models`)).status).toBe(200);
    await ready.getByRole('button', { name: 'Ferma' }).click();
    await expect(page.getByText(/fermato/)).toBeVisible();
    await expect.poll(() => fetch(`${url}/models`).then((r) => r.status, () => 0), { timeout: 20_000 }).toBe(0);
  } finally {
    await gb.close();
    rmSync(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test('NInfer "Aggiorna" like the other engines: new commits, the exact commands, then the new build; an older model to upgrade', async () => {
  const userData = mkdtempSync(path.join(os.tmpdir(), 'gpubench-e2e-ninfer-up-'));
  seedNinfer(path.join(userData, 'models', 'local'), 2);
  const gb = await launchApp({
    userData,
    env: {
      GPUBENCH_WSL: JSON.stringify([process.execPath, path.join(ROOT, 'test', 'fakes', 'fake-wsl', 'fake-wsl.mjs')]),
      FAKE_WSL_STATE: path.join(userData, 'fake-wsl'),
      FAKE_WSL_CONFIG: JSON.stringify({
        incoming: [
          { sha: '4f2a9c1d0e8b7a6f5e4d3c2b1a0f9e8d7c6b5a49', title: 'serve: faster MTP verification' },
          { sha: '9d8c7b6a5f4e3d2c1b0a9f8e7d6c5b4a3f2e1d0c', title: 'docs: KV capacity examples' },
        ],
      }),
    },
  });
  try {
    const { page } = gb;
    await skipWelcome(page);
    const card = await useBuild(page);
    await expect(card.getByText('e31bc99b13f5')).toBeVisible();

    // "Aggiorna", as on every engine card: two commits behind with their titles; the v2 model needs
    // NInfer's upgrade tool.
    await expect(card.getByText('2 commit nuovi: e31bc99 → 4f2a9c1')).toBeVisible({ timeout: 20_000 });
    await expect(card.getByText('serve: faster MTP verification')).toBeVisible();
    await expect(card.getByText('Modelli da aggiornare')).toBeVisible();
    await expect(card.getByRole('region', { name: 'Comando da copiare' })).toContainText('python3 tools/upgrade_ninfer_v2_to_v3.py');
    await scan(page, 'NInfer update available');

    // The exact commands and the way back, inside the distro; then the update with its progress.
    await card.getByRole('button', { name: 'Aggiorna', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Aggiornare NInfer (WSL)?' });
    await expect(dialog.getByText(/Tutto succede dentro Ubuntu-24.04/)).toBeVisible();
    await expect(dialog.getByRole('region', { name: 'Comandi che eseguo' })).toContainText('git -C /home/user/ninfer pull --ff-only');
    await expect(dialog.getByRole('region', { name: 'Per tornare com’era' })).toContainText('git -C /home/user/ninfer reset --hard e31bc99b13f517c8aae70b997b7c4a49b4dcdc5d');
    await scan(page, 'NInfer update dialog');
    await dialog.getByRole('button', { name: 'Aggiorna', exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(card.getByText('Aggiornato a 4f2a9c1')).toBeVisible({ timeout: 30_000 });
    await expect(card.getByText('4f2a9c1d0e8b')).toBeVisible({ timeout: 20_000 });
    await expect(card.getByText('Hai l’ultima versione (4f2a9c1)')).toBeVisible({ timeout: 20_000 });
  } finally {
    await gb.close();
    rmSync(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
