/**
 * NInfer like a person, on Windows (inside WSL) or on Linux (on this PC): its card's official build
 * pointed at the user's own folder, a Rapido benchmark with "Consigliata da NInfer", a server with the
 * same settings stopped; "Aggiorna" in one click (pull and rebuild, with the models to upgrade); and
 * "Scarica e compila" from nothing, ready with no other step.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, launchApp, test } from '../fixtures';
import { h1, scan, skipWelcome } from './bench-helpers';
import { openPage } from './library-helpers';
import { chooseNinfer, folderValue, IN_COMMAND, ninferCard, ninferEnv, OFFICIAL_SAVED } from './ninfer-helpers';

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

test('NInfer: the user\'s own build pointed at, a Rapido benchmark with its recommended settings, a server started and stopped', async () => {
  const userData = mkdtempSync(path.join(os.tmpdir(), 'gpubench-e2e-ninfer-'));
  seedNinfer(path.join(userData, 'models', 'local'));
  const gb = await launchApp({ userData, env: { ...ninferEnv(userData), FAKE_ENGINE_PROFILE: JSON.stringify({ loadMsWarm: 300, prefillTps: 20_000, decodeTps: 900, tokensPerChunk: 2 }) } });
  try {
    const { page } = gb;
    await skipWelcome(page);

    // Motori: NInfer and its two builds; none set up yet.
    await openPage(page, 'Motori');
    const { card, official, all } = ninferCard(page);
    await expect(card.getByText('solo RTX 5090 · Linux / WSL')).toBeVisible();
    await expect(card.getByText('Da configurare')).toBeVisible({ timeout: 20_000 });
    await expect(official.getByText('Non installato')).toBeVisible();
    await expect(all.getByText('Non installato')).toBeVisible();
    await expect(all.getByText(/Ti serve solo per i modelli GGUF-NInfer/)).toBeVisible();
    // The user's own build: a wrong folder is said, the right one is taken.
    await official.getByRole('button', { name: 'Ce l’ho già: indica la cartella' }).click();
    const where = official.getByRole('textbox', { name: 'Dove si trova NInfer' });
    await where.fill('/home/user/nowhere');
    await official.getByRole('button', { name: 'Controlla e usa' }).click();
    await expect(official.getByText('ninfer-serve non è qui: /home/user/nowhere/build/apps/ninfer-serve')).toBeVisible({ timeout: 20_000 });
    await where.fill('/home/user/ninfer');
    await official.getByRole('button', { name: 'Controlla e usa' }).click();
    await expect(official.getByText('Pronto')).toBeVisible({ timeout: 20_000 });
    await expect(official.getByText('e31bc99', { exact: true })).toBeVisible();
    await expect(folderValue(official, '/home/user/ninfer')).toBeVisible();
    await expect(card.getByText('Pronto').first()).toBeVisible();
    await scan(page, 'NInfer card');

    // Benchmark: NInfer, the .ninfer model, NInfer's own recommended settings.
    await openPage(page, 'Benchmark');
    await chooseNinfer(page);
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
    await expect(preview).toContainText(IN_COMMAND);
    await scan(page, 'benchmark with NInfer settings');

    await page.getByRole('button', { name: 'Avvia benchmark' }).click();
    await expect(h1(page, 'Test in corso')).toBeVisible({ timeout: 30_000 });
    await expect(h1(page, /qwen3_8_27b_nvfp4/)).toBeVisible({ timeout: 90_000 });
    await expect(page.getByText('Completato', { exact: true })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Numeri principali' }).getByText('Generazione')).toBeVisible();
    await page.getByRole('tab', { name: 'Come è stato avviato' }).click();
    await page.getByRole('button', { name: 'Mostra comando' }).click();
    await expect(page.getByRole('region', { name: 'Comando' })).toContainText('ninfer-serve');
    await scan(page, 'NInfer result');

    // A server with the same settings from the Benchmark page, then stopped.
    await openPage(page, 'Benchmark');
    await page.getByRole('button', { name: 'Avvia solo il server', exact: true }).click();
    await expect(h1(page, 'Avvia un server')).toBeVisible();
    await expect(page.getByRole('radio', { name: /Consigliata da NInfer: contesto 240K/ })).toBeChecked();
    const command = page.getByRole('region', { name: 'Comando esatto' });
    await expect(command).toContainText('--kv-capacity 240000', { timeout: 30_000 });
    await expect(command).not.toContainText('--no-prefix-reuse');
    await scan(page, 'NInfer server start');
    await page.getByRole('button', { name: /^(Avvia|Scarica e avvia)$/ }).click();
    await expect(h1(page, /^Server$/)).toBeVisible({ timeout: 90_000 });
    const running = page.getByRole('region', { name: /^Server .* sulla porta \d+$/ });
    const url = (await running.getByText(/^http:\/\/127\.0\.0\.1:\d+\/v1$/).first().textContent())!;
    expect((await fetch(`${url}/models`)).status).toBe(200);
    await running.getByRole('button', { name: /^Ferma il server/ }).click();
    await expect(page.getByText(/fermato/)).toBeVisible();
    await expect.poll(() => fetch(`${url}/models`).then((r) => r.status, () => 0), { timeout: 20_000 }).toBe(0);
  } finally {
    await gb.close();
    rmSync(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test('NInfer "Aggiorna" in one click: the new commits, then pulled and rebuilt with its progress; an older model to upgrade', async () => {
  const userData = mkdtempSync(path.join(os.tmpdir(), 'gpubench-e2e-ninfer-up-'));
  seedNinfer(path.join(userData, 'models', 'local'), 2);
  const gb = await launchApp({
    userData,
    settings: { ninfer: OFFICIAL_SAVED },
    env: ninferEnv(userData, {
      incoming: [
        { sha: '4f2a9c1d0e8b7a6f5e4d3c2b1a0f9e8d7c6b5a49', title: 'serve: faster MTP verification' },
        { sha: '9d8c7b6a5f4e3d2c1b0a9f8e7d6c5b4a3f2e1d0c', title: 'docs: KV capacity examples' },
      ],
    }),
  });
  try {
    const { page } = gb;
    await skipWelcome(page);
    await openPage(page, 'Motori');
    const { official } = ninferCard(page);
    await expect(official.getByText('Pronto')).toBeVisible({ timeout: 20_000 });
    // Two commits behind with their titles; the v2 model needs NInfer's upgrade tool.
    await expect(official.getByText('2 commit nuovi: e31bc99 → 4f2a9c1')).toBeVisible({ timeout: 20_000 });
    await expect(official.getByText('serve: faster MTP verification')).toBeVisible();
    await expect(official.getByText('Modelli da aggiornare')).toBeVisible();
    await expect(official.getByRole('region', { name: 'Comando da copiare' })).toContainText('python3 tools/upgrade_ninfer_v2_to_v3.py');
    await scan(page, 'NInfer update available');
    // One click: pulled and rebuilt in its folder, then the newest code.
    await official.getByRole('button', { name: 'Aggiorna', exact: true }).click();
    await expect(official.getByText('Hai l’ultima versione (4f2a9c1)')).toBeVisible({ timeout: 60_000 });
    await expect(official.getByText('4f2a9c1', { exact: true })).toBeVisible({ timeout: 20_000 });
  } finally {
    await gb.close();
    rmSync(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test('NInfer not on the PC yet: "Scarica e compila" checks what it needs, downloads and builds it, and it is ready with no other step', async () => {
  const userData = mkdtempSync(path.join(os.tmpdir(), 'gpubench-e2e-ninfer-dl-'));
  // Nothing cloned, nothing built.
  const gb = await launchApp({ userData, env: ninferEnv(userData, { checkouts: [], builds: [] }) });
  try {
    const { page } = gb;
    await skipWelcome(page);
    await openPage(page, 'Motori');
    const { official } = ninferCard(page);
    await expect(official.getByText('Non installato')).toBeVisible({ timeout: 20_000 });
    // "Avanzate": the exact commands, before anything runs.
    await official.getByText('Avanzate').click();
    await official.getByRole('button', { name: 'Mostra i comandi' }).click();
    await expect(official.getByRole('region', { name: 'Comandi che eseguirò' })).toContainText('https://github.com/Neroued/ninfer.git /home/user/ninfer', { timeout: 30_000 });
    await scan(page, 'download and build NInfer');
    await official.getByRole('button', { name: 'Scarica e compila' }).click();
    await expect(page.getByText('NInfer (ufficiale) è pronto.')).toBeVisible({ timeout: 60_000 });
    await expect(official.getByText('Pronto')).toBeVisible({ timeout: 30_000 });
    await expect(folderValue(official, '/home/user/ninfer')).toBeVisible();
  } finally {
    await gb.close();
    rmSync(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
