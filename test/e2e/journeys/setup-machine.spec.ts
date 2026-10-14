import type { Locator } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, launchApp, test, type AppHandle } from '../fixtures';
import { h1, openPage, opened, scan, skipWelcome, startLibraryWorld, stubDesktop, type LibraryWorld } from './library-helpers';

test.describe.configure({ timeout: 120_000 });

let world: LibraryWorld;

test.beforeAll(async () => {
  world = await startLibraryWorld();
});

test.afterAll(async () => {
  await world.close();
});

test('no NVIDIA driver: plain guidance, the official page, then check again', async () => {
  const gb = await launchApp({ env: { ...world.env, FAKE_NVIDIA_SMI_MODE: 'absent' } });
  try {
    const { page } = gb;
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await stubDesktop(gb);
    const check = page.getByRole('region', { name: 'Controllo del sistema' });
    await expect(check.getByText('Non ho trovato il driver NVIDIA: serve per usare la scheda video.')).toBeVisible({ timeout: 20_000 });
    await expect(check.getByText('La vedrò appena avrai installato il driver.')).toBeVisible();
    await expect(check.getByText('Prima serve il driver NVIDIA: senza, la scheda video non si può usare.')).toBeVisible();
    await scan(page, 'driver missing');
    await check.getByRole('button', { name: 'Scarica il driver (Driver NVIDIA)' }).click();
    await expect.poll(() => opened(gb)).toEqual([expect.stringMatching(/^https:\/\/www\.nvidia\.com\//)]);
    const hint = check.getByRole('note').filter({ hasText: 'Installa il driver dalla pagina che si è aperta' });
    await expect(hint).toBeVisible();
    await scan(page, 'driver page opened');
    await hint.getByRole('button', { name: 'Ricontrolla' }).click();
    await expect(check.getByText('Non ho trovato il driver NVIDIA: serve per usare la scheda video.')).toBeVisible();

    // Without the driver there is nothing to read on the monitor.
    await page.getByRole('button', { name: 'Salta, lo farò dopo' }).click();
    await expect(h1(page, 'Benchmark')).toBeVisible();
    await openPage(page, 'Monitor GPU');
    await expect(page.getByRole('heading', { name: 'Telemetria non disponibile' })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole('region', { name: 'Stato della GPU' }).getByText('Nessuna GPU NVIDIA trovata')).toBeVisible();
    await scan(page, 'monitor without NVIDIA');
  } finally {
    await gb.close();
  }
});

/**
 * Docker is off and gets started. Windows: "Avvia Docker" starts Docker Desktop and waits for it.
 * Linux: Docker is a system service, so no such button anywhere: the system check and "Come avviarlo"
 * give its command, the user runs it (the fake Docker comes up), then "Riprova".
 */
async function startDocker(gb: AppHandle, docker: Locator): Promise<void> {
  const { page } = gb;
  if (process.platform === 'win32') {
    await docker.getByRole('button', { name: 'Avvia Docker' }).click();
    return;
  }
  const check = page.getByRole('region', { name: 'Controllo del sistema' });
  await expect(check.getByText('È installato ma spento: su Linux si avvia con «sudo systemctl start docker». Serve per vLLM e SGLang.')).toBeVisible();
  await expect(page.getByRole('button', { name: /^Avvia Docker/ })).toHaveCount(0);
  await docker.getByRole('button', { name: 'Come avviarlo' }).click();
  const gate = page.getByRole('dialog', { name: 'Docker è spento' });
  await expect(gate.getByRole('region', { name: 'Docker è spento' })).toHaveText('sudo systemctl start docker');
  await scan(page, 'docker stopped: the command on Linux');
  // The user runs it in a terminal: fake-docker.mjs reads <state>/mode.json at every call.
  const state = path.join(gb.userData, 'fake-docker');
  mkdirSync(state, { recursive: true });
  writeFileSync(path.join(state, 'mode.json'), JSON.stringify({ mode: 'running' }));
  await gate.getByRole('button', { name: 'Riprova' }).click();
  await expect(gate).toBeHidden({ timeout: 20_000 });
}

test('Docker stopped: started from here (Windows) or with its command (Linux); then GPU check, image download and cleanup', async () => {
  const gb = await launchApp({ env: { ...world.env, FAKE_DOCKER_MODE: 'daemon-down', FAKE_DOCKER_START_MS: '1500' } });
  try {
    const { page } = gb;
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await skipWelcome(page);
    await openPage(page, 'Motori');
    const docker = page.getByRole('region', { name: 'Docker', exact: true });
    await expect(docker.getByText('Spento', { exact: true })).toBeVisible({ timeout: 20_000 });
    await scan(page, 'docker stopped');
    await startDocker(gb, docker);
    await expect(docker.getByText('Acceso', { exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole('region', { name: 'Controllo del sistema' }).getByText(/^Docker .* è pronto\. Serve per vLLM e SGLang\.$/)).toBeVisible({ timeout: 20_000 });

    await docker.getByRole('button', { name: 'Verifica la GPU in Docker' }).click();
    await expect(docker.getByText('Docker vede la scheda video')).toBeVisible({ timeout: 30_000 });
    await docker.getByRole('button', { name: 'Scarica l’immagine di llama.cpp' }).click();
    await expect(docker.getByText('Immagine pronta: ghcr.io/ggml-org/llama.cpp:server-cuda')).toBeVisible({ timeout: 30_000 });
    await docker.getByRole('button', { name: 'Pulisci i contenitori di LLM Bench' }).click();
    await expect(page.getByText(/^Contenitori rimossi: \d+$/)).toBeVisible();
    await scan(page, 'docker running');

    // vLLM: tags from Docker Hub with the one recommended for this GPU.
    const tags = page.getByRole('list', { name: 'Versioni di vLLM (immagini Docker)' });
    await expect(tags.getByText('Consigliato')).toBeVisible({ timeout: 20_000 });
    await tags.getByRole('button', { name: 'Usa questa' }).first().click();
    await expect(tags.getByText('In uso')).toBeVisible();
  } finally {
    await gb.close();
  }
});

test('Docker not installed: the guided install asks first and explains what will happen', async () => {
  const gb = await launchApp({ env: { ...world.env, GPUBENCH_DOCKER: JSON.stringify(['gpubench-no-such-docker']) } });
  try {
    const { page } = gb;
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const check = page.getByRole('region', { name: 'Controllo del sistema' });
    await expect(check.getByText('Facoltativo: serve solo per vLLM e SGLang.')).toBeVisible({ timeout: 20_000 });
    await check.getByRole('button', { name: /^Installa Docker.*\(Docker\)$/ }).click();
    // Windows: Docker Desktop and the UAC prompt; Linux: the exact script and the password prompt.
    const dialog = page.getByRole('dialog', { name: /^Installare Docker (Desktop|Engine)\?$/ });
    await expect(dialog.getByText(/permesso di amministratore|password di amministratore/)).toBeVisible();
    await scan(page, 'docker install confirmation');
    await dialog.getByRole('button', { name: 'Annulla' }).click();
    await expect(dialog).toBeHidden();
  } finally {
    await gb.close();
  }
});
