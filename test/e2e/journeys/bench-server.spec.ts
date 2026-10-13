import { expect, launchApp, test } from '../fixtures';
import { h1, scan, skipWelcome } from './bench-helpers';
import { cardUrl, modelsStatus, serverCard } from './server-helpers';

test.describe.configure({ timeout: 180_000 });

const FAST = { FAKE_ENGINE_PROFILE: JSON.stringify({ loadMsWarm: 300, loadMsCold: 300, prefillTps: 15000, decodeTps: 1500, tokensPerChunk: 4 }) };

test('a server from "Le migliori dai tuoi test": its address to copy, the sidebar card, Ferma; then like a past run, and a benchmark asks to stop it first', async () => {
  const gb = await launchApp({ env: FAST });
  try {
    const { page, app } = gb;
    await skipWelcome(page);
    // A quick test first: its configuration is what the server will use.
    await page.getByRole('button', { name: 'Avvia benchmark' }).click();
    await page.getByRole('button', { name: 'Scarica e avvia' }).click();
    await expect(h1(page, /Qwen3-0\.6B/)).toBeVisible({ timeout: 60_000 });

    // The Server page: nothing on yet, and the one way to start a server.
    const nav = page.getByRole('navigation', { name: 'Navigazione principale' });
    await nav.getByRole('link', { name: 'Server', exact: true }).click();
    await expect(h1(page, /^Server$/)).toBeVisible();
    await expect(page.getByText('Nessun server acceso')).toBeVisible();
    await page.getByRole('link', { name: 'Avvia un server' }).first().click();
    await expect(h1(page, 'Avvia un server')).toBeVisible();

    // "Le migliori dai tuoi test": the test just made, with its speed; the exact command before "Avvia".
    const tested = page.getByRole('radio', { name: / tok\/s a / }).first();
    await expect(tested).toBeVisible({ timeout: 30_000 });
    await tested.click();
    await expect(page.getByText('Viene dalle impostazioni scelte.')).toBeVisible();
    const command = page.getByRole('region', { name: 'Comando esatto' });
    await expect(command).toContainText('Qwen3-0.6B-Q4_K_M.gguf');
    await expect(command).toContainText('--port');
    await scan(page, 'start a server from a test');
    await page.getByRole('button', { name: /^(Avvia|Scarica e avvia)$/ }).click();

    // Its card: ready, the address to copy; other programs really can use it.
    await expect(h1(page, /^Server$/)).toBeVisible({ timeout: 60_000 });
    const card = serverCard(page, /Qwen3 0\.6B.*/);
    await expect(card.getByText('Acceso', { exact: true })).toBeVisible({ timeout: 60_000 });
    const url = await cardUrl(card);
    await app.evaluate(({ clipboard }) => clipboard.writeText(''));
    await card.getByRole('button', { name: /^Copia l’URL base di / }).click();
    await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText())).toBe(url);
    expect(await modelsStatus(url)).toBe(200);
    await scan(page, 'a running server');

    // The sidebar says it on every other page, and leads back here.
    await nav.getByRole('link', { name: 'Benchmark' }).click();
    const sidebar = page.getByRole('link', { name: /^Server attivi: 1\./ });
    await expect(sidebar).toBeVisible();
    await scan(page, 'sidebar with a running server');
    await sidebar.click();
    await expect(h1(page, /^Server$/)).toBeVisible();

    // Ferma: the model is closed, the address stops answering.
    await card.getByRole('button', { name: /^Ferma il server / }).click();
    await expect(page.getByText(/fermato/)).toBeVisible();
    await expect(page.getByText('Nessun server acceso')).toBeVisible();
    await expect.poll(() => modelsStatus(url), { timeout: 20_000 }).toBe(0);

    // Like the past run ("Avvia solo il server così"): that test's settings; then a benchmark asks to stop it first.
    await nav.getByRole('link', { name: 'Risultati' }).click();
    await page.getByRole('link', { name: /Qwen3-0\.6B/ }).first().click();
    await page.getByRole('tab', { name: 'Come è stato avviato' }).click();
    await page.getByRole('button', { name: 'Avvia solo il server così' }).click();
    await expect(page.getByRole('radio', { name: /^Dal test del/ })).toBeChecked();
    await expect(page.getByRole('region', { name: 'Comando esatto' })).toBeVisible({ timeout: 30_000 });
    await page.getByRole('button', { name: /^(Avvia|Scarica e avvia)$/ }).click();
    await expect(serverCard(page, /Qwen3 0\.6B.*/).getByText('Acceso', { exact: true })).toBeVisible({ timeout: 60_000 });
    await nav.getByRole('link', { name: 'Risultati' }).click();
    await page.getByRole('link', { name: /Qwen3-0\.6B/ }).first().click();
    await page.getByRole('tab', { name: 'Come è stato avviato' }).click();
    await page.getByRole('button', { name: 'Rifai questo benchmark' }).click();
    const own = page.getByRole('dialog', { name: 'Un server avviato da LLM Bench sta usando la scheda video' });
    await expect(own).toBeVisible();
    await own.getByRole('button', { name: 'Ferma il server e avvia' }).click();
    await expect(h1(page, 'Test in corso')).toBeVisible({ timeout: 30_000 });
    await expect(h1(page, /Qwen3-0\.6B/)).toBeVisible({ timeout: 60_000 });
  } finally {
    await gb.close();
  }
});
