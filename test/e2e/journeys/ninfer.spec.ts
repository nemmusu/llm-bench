/**
 * NInfer like a person on Windows: point GPU Bench at the build inside WSL (a fake wsl.exe whose
 * distro runs the fake ninfer-serve), pick the "Consigliata da NInfer" settings for a .ninfer model,
 * run a Rapido benchmark, then start a server with the same settings and stop it.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
function seedNinfer(modelsDir: string): void {
  const dir = path.join(modelsDir, 'neroued', 'Qwen3.8-27B-nvfp4-NInfer');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'qwen3_8_27b_nvfp4.ninfer'), Buffer.alloc(65_536));
  writeFileSync(path.join(dir, 'Qwen3.8-27B-nvfp4-NInfer.artifact-manifest.json'), JSON.stringify(MANIFEST));
  writeFileSync(path.join(dir, 'Qwen3.8-27B-nvfp4-NInfer.SHA256SUMS'), `${'74'.repeat(32)}  qwen3_8_27b_nvfp4.ninfer\n`);
}

test('NInfer through WSL: find the build, run a Rapido benchmark with its recommended settings, serve and stop', async () => {
  test.skip(process.platform !== 'win32', 'NInfer through WSL is the Windows journey');
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
    const card = page.getByRole('region', { name: 'NInfer' });
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
