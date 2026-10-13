/**
 * The benchmark flow for someone who reads English: switch the language in Settings, preview a
 * suggested model that is not on the PC yet, let the app fetch it with llama.cpp, read the result,
 * compare it with an older one.
 */
import { expect, launchApp, test } from '../fixtures';
import { h1, launchSeeded, scan, skipWelcome } from './bench-helpers';
import { openPage, startLibraryWorld, type LibraryWorld } from './library-helpers';

test.describe.configure({ timeout: 180_000 });

let world: LibraryWorld;

test.beforeAll(async () => {
  world = await startLibraryWorld();
});

test.afterAll(async () => {
  await world.close();
});

test('in English: the full preview before any download, the first run, reading the result, comparing', async () => {
  const gb = await launchSeeded({ env: world.env });
  try {
    const { page } = gb;
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await skipWelcome(page);
    await openPage(page, 'Impostazioni');
    await page.getByRole('combobox', { name: 'Lingua' }).click();
    await page.getByRole('option', { name: 'English' }).click();
    await expect(h1(page, 'Settings')).toBeVisible();

    // A suggested model that is not on this PC yet.
    await openPage(page, 'Benchmark');
    await expect(page.getByRole('heading', { name: 'Ready to measure your RTX 5090' })).toBeVisible();
    await page.getByRole('button', { name: /^Change model:/ }).click();
    const picker = page.getByRole('dialog', { name: 'Choose a model' });
    await expect(picker.getByText('Suggested for your RTX 5090 (32 GB). The ones already on your PC start right away.')).toBeVisible();
    await picker.getByRole('radio', { name: /^Qwen3 4B Q4_K_M/ }).click();
    await picker.getByRole('button', { name: 'Confirm' }).click();
    await expect(page.getByRole('button', { name: 'Change model: Qwen3 4B Q4_K_M' })).toBeVisible();

    // The whole preview before anything is downloaded: what gets prepared first, the fit, the exact command.
    await expect(page.getByText('· will be downloaded before the test')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText('· will be installed before the test')).toBeVisible();
    await expect(page.getByText(/^Will be downloaded before the test: /)).toBeVisible();
    await expect(page.getByText(/^First I download llama\.cpp and Qwen3 4B · Q4_K_M: /)).toBeVisible();
    await expect(page.getByText('Fits perfectly').first()).toBeVisible();
    await page.getByRole('button', { name: /Command preview/ }).click();
    await expect(page.getByText('The model is not on your PC yet: the command already uses the path where I will save it before the test.')).toBeVisible();
    await expect(page.getByText('llama.cpp is not installed yet: the command already uses the folder where I will install it before the test.')).toBeVisible();
    await expect(page.getByRole('region', { name: 'Command preview' })).toContainText('Qwen3-4B-Q4_K_M.gguf');
    await scan(page, 'benchmark preview in English');

    // One confirmation, then install, download and run by themselves.
    await page.getByRole('button', { name: 'Start benchmark' }).click();
    const confirm = page.getByRole('dialog', { name: 'Before starting I download what is missing' });
    await expect(confirm.getByText('Install llama.cpp')).toBeVisible();
    await expect(confirm.getByText('Download Qwen3 4B · Q4_K_M')).toBeVisible();
    await scan(page, 'needs confirmation in English');
    await confirm.getByRole('button', { name: 'Download and start' }).click();

    await expect(h1(page, 'Test in progress')).toBeVisible({ timeout: 60_000 });
    const phases = page.getByRole('list', { name: 'Test phases' });
    await expect(phases.getByText('Installing')).toBeVisible();
    await expect(phases.getByText('Downloading')).toBeVisible();
    await scan(page, 'live run in English');

    // Reading the result.
    await expect(h1(page, /Qwen3-4B-Q4_K_M/)).toBeVisible({ timeout: 90_000 });
    await expect(page.getByText('Completed', { exact: true })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Key numbers' }).getByText('Generation')).toBeVisible();
    await expect(page.getByText(/It writes about \d+ words per second/)).toBeVisible();
    await scan(page, 'result in English');
    await page.getByRole('tab', { name: 'How it was started' }).click();
    await page.getByRole('button', { name: 'Show command' }).click();
    await expect(page.getByRole('region', { name: 'Command' })).toContainText('Qwen3-4B-Q4_K_M.gguf');

    // The history: this run next to the older ones; "This PC only" leaves out the other computer.
    await page.getByRole('link', { name: 'All results' }).click();
    await expect(h1(page, 'Results')).toBeVisible();
    await expect(page.getByText('10 results')).toBeVisible();
    await expect(page.getByText('Other PC')).toBeVisible();
    await page.getByRole('switch', { name: 'This PC only' }).click();
    await expect(page.getByText('9 results')).toBeVisible();
    await expect(page.getByText('Other PC')).toBeHidden();
    await page.getByRole('switch', { name: 'This PC only' }).click();

    // Compare it with an older run: "Compare" on each row, then the tray.
    await page.getByRole('button', { name: /^Compare Qwen3-4B-Q4_K_M/ }).click();
    await page.getByRole('button', { name: /^Compare Gemma 4 31B/ }).click();
    await page.getByRole('region', { name: 'To compare' }).getByRole('button', { name: 'Compare', exact: true }).click();
    await expect(h1(page, 'Compare')).toBeVisible();
    await expect(page.getByRole('table', { name: 'Comparison, measurement by measurement' }).getByRole('row', { name: /^Generation \(tok\/s\)/ })).toContainText('writing with 512 tokens already in context');
    await page.getByRole('button', { name: /What changes between them/ }).click();
    await expect(page.getByRole('table', { name: 'What changes between them' })).toContainText('Qwen3-4B-Q4_K_M');
    await scan(page, 'compare in English');
  } finally {
    await gb.close();
  }
});

test('in English: the app is reloaded during a run and the live screen comes back as it was', async () => {
  // Slow generation: the run is still going after the reload.
  const gb = await launchApp({ env: { FAKE_ENGINE_PROFILE: JSON.stringify({ loadMsCold: 800, loadMsWarm: 400, prefillTps: 9000, decodeTps: 12 }) } });
  try {
    const { page } = gb;
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await skipWelcome(page);
    await openPage(page, 'Impostazioni');
    await page.getByRole('combobox', { name: 'Lingua' }).click();
    await page.getByRole('option', { name: 'English' }).click();
    await openPage(page, 'Benchmark');
    await page.getByRole('button', { name: 'Start benchmark' }).click();
    await page.getByRole('dialog', { name: 'Before starting I download what is missing' }).getByRole('button', { name: 'Download and start' }).click();
    await expect(h1(page, 'Test in progress')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/The model is writing sample text/)).toBeVisible({ timeout: 30_000 });

    // A reload forgets everything the start flow knew: the core tells the screen what is running.
    await page.reload();
    await expect(h1(page, 'Test in progress')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/^Qwen3-0\.6B-Q4_K_M · llama\.cpp b\d+ \(CUDA [\d.]+\) · Quick$/)).toBeVisible();
    await expect(page.getByText(/^About .+ left$/)).toBeVisible();
    await expect(page.getByRole('list', { name: 'Test phases' }).getByText('Generation')).toBeVisible();
    await scan(page, 'reloaded live run in English');

    await page.getByRole('button', { name: 'Cancel test' }).click();
    await page.getByRole('alertdialog', { name: 'Cancel the test?' }).getByRole('button', { name: 'Cancel the test' }).click();
    await expect(page.getByText('Cancelled', { exact: true })).toBeVisible({ timeout: 30_000 });
  } finally {
    await gb.close();
  }
});
