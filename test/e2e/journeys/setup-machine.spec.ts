import { expect, launchApp, test } from '../fixtures';
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

test('Docker stopped: "Avvia Docker" brings it up; then GPU check, image download and cleanup', async () => {
  const gb = await launchApp({ env: { ...world.env, FAKE_DOCKER_MODE: 'daemon-down', FAKE_DOCKER_START_MS: '1500' } });
  try {
    const { page } = gb;
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await skipWelcome(page);
    await openPage(page, 'Motori');
    const docker = page.getByRole('region', { name: 'Docker', exact: true });
    await expect(docker.getByText('Spento', { exact: true })).toBeVisible({ timeout: 20_000 });
    await scan(page, 'docker stopped');
    await docker.getByRole('button', { name: 'Avvia Docker' }).click();
    await expect(docker.getByText('Acceso', { exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole('region', { name: 'Controllo del sistema' }).getByText(/^Docker .* è pronto\. Serve solo per vLLM\.$/)).toBeVisible({ timeout: 20_000 });

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
    await expect(check.getByText('Facoltativo: serve solo per usare vLLM.')).toBeVisible({ timeout: 20_000 });
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
