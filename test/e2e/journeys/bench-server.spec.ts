import { expect, launchApp, test } from '../fixtures';
import { h1, scan, skipWelcome } from './bench-helpers';

test.describe.configure({ timeout: 150_000 });

test('start only the server like a past run, use its address, stop it; a benchmark asks to stop it first', async () => {
  const gb = await launchApp({ env: { FAKE_ENGINE_PROFILE: JSON.stringify({ loadMsWarm: 300, prefillTps: 15000, decodeTps: 1500, tokensPerChunk: 4 }) } });
  try {
    const { page, app } = gb;
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await skipWelcome(page);
    await page.getByRole('button', { name: 'Avvia benchmark' }).click();
    await page.getByRole('button', { name: 'Scarica e avvia' }).click();
    await expect(h1(page, /Qwen3-0\.6B/)).toBeVisible({ timeout: 60_000 });

    // Server only, with this run's exact settings.
    await page.getByRole('tab', { name: 'Come è stato avviato' }).click();
    await page.getByRole('button', { name: 'Avvia solo il server così' }).click();
    const dialog = page.getByRole('dialog', { name: 'Avvia solo il server' });
    await expect(dialog.getByText('Mentre il server è acceso non puoi fare benchmark')).toBeVisible();
    await dialog.getByRole('button', { name: 'Avvia il server' }).click();
    await expect(dialog.getByText('Indirizzo compatibile OpenAI')).toBeVisible({ timeout: 30_000 });
    await scan(page, 'server ready');
    const url = (await dialog.getByText(/^http:\/\/127\.0\.0\.1:\d+\/v1$/).textContent())!;
    await app.evaluate(({ clipboard }) => clipboard.writeText(''));
    await dialog.getByRole('button', { name: 'Copia l’indirizzo compatibile OpenAI' }).click();
    await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText())).toBe(url);
    // Other programs really can talk to it.
    expect((await fetch(`${url}/models`)).status).toBe(200);
    await dialog.getByRole('button', { name: 'Lascia acceso' }).click();

    // The Benchmark page lists it and can stop it.
    await page.getByRole('navigation', { name: 'Navigazione principale' }).getByRole('link', { name: 'Benchmark' }).click();
    const panel = page.getByRole('heading', { name: 'Server attivi' });
    await expect(panel).toBeVisible();
    await scan(page, 'running servers');
    await page.getByRole('button', { name: /Ferma il server di/ }).click();
    await expect(page.getByText(/fermato/)).toBeVisible();
    await expect(panel).toBeHidden();

    // Start it again, then try a benchmark: GPU Bench offers to stop it first.
    await page.getByRole('link', { name: /Qwen3-0\.6B/ }).first().click();
    await page.getByRole('tab', { name: 'Come è stato avviato' }).click();
    await page.getByRole('button', { name: 'Avvia solo il server così' }).click();
    await page.getByRole('button', { name: 'Avvia il server' }).click();
    await expect(page.getByText('Indirizzo compatibile OpenAI')).toBeVisible({ timeout: 30_000 });
    await page.getByRole('button', { name: 'Lascia acceso' }).click();
    await page.getByRole('button', { name: 'Rifai questo benchmark' }).click();
    const own = page.getByRole('dialog', { name: 'Un server avviato da GPU Bench sta usando la scheda video' });
    await expect(own).toBeVisible();
    await own.getByRole('button', { name: 'Ferma il server e avvia' }).click();
    await expect(h1(page, 'Test in corso')).toBeVisible({ timeout: 30_000 });
    await expect(h1(page, /Qwen3-0\.6B/)).toBeVisible({ timeout: 60_000 });
  } finally {
    await gb.close();
  }
});
