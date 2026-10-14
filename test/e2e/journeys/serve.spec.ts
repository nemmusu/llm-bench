/**
 * A server of one's own, kept running: "Comandi personalizzati" saved as a preset that starts with
 * LLM Bench, started from it; closing the window keeps LLM Bench in the tray (the tray through the
 * main process's test hooks, see server-helpers.ts) and the server answering; "Esci" stops it.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, launchApp, test } from '../fixtures';
import { h1, scan, skipWelcome } from './bench-helpers';
import { cardUrl, expectTrayLine, hook, modelsStatus, serverCard } from './server-helpers';

test.describe.configure({ timeout: 180_000 });

const FAST = { FAKE_ENGINE_PROFILE: JSON.stringify({ loadMsWarm: 300, loadMsCold: 300, prefillTps: 15000, decodeTps: 1500, tokensPerChunk: 4 }) };
/** A port of this test's own, far from 8080 (other journeys may run servers at the same time). */
const PORT = 18431;
const URL = `http://127.0.0.1:${PORT}/v1`;

test('custom commands saved as a preset and started from it; the window closes to the tray, the server keeps answering; "Esci" stops it; the preset starts with LLM Bench', async () => {
  const userData = mkdtempSync(path.join(os.tmpdir(), 'gpubench-e2e-serve-'));
  let gb = await launchApp({ env: FAST, userData });
  try {
    const { page, app } = gb;
    await skipWelcome(page);
    const nav = page.getByRole('navigation', { name: 'Navigazione principale' });
    await nav.getByRole('link', { name: 'Server', exact: true }).click();
    await page.getByRole('link', { name: 'Avvia un server' }).first().click();
    await expect(h1(page, 'Avvia un server')).toBeVisible();

    // "Comandi personalizzati": the context, an extra argument and a port of its own; the exact command follows.
    await page.getByRole('tab', { name: 'Comandi personalizzati' }).click();
    await page.getByLabel('Contesto (token)').fill('4096');
    await page.getByLabel('Argomenti extra').fill('--metrics');
    await page.getByRole('textbox', { name: 'Porta' }).fill(String(PORT));
    const command = page.getByRole('region', { name: 'Comando esatto' });
    await expect(command).toContainText('--metrics', { timeout: 30_000 });
    await expect(command).toContainText('-c 4096');
    await expect(command).toContainText(String(PORT));
    await scan(page, 'custom commands');

    // Saved as a preset that starts with LLM Bench.
    await page.getByRole('button', { name: 'Salva come preset' }).click();
    const save = page.getByRole('dialog', { name: 'Salva come preset' });
    await expect(save.getByText(`porta ${PORT}.`, { exact: false })).toBeVisible();
    await save.getByLabel('Nome').fill('Chat veloce');
    await save.getByRole('checkbox', { name: /Avvia all’apertura di LLM Bench/ }).click();
    await scan(page, 'save as preset');
    await save.getByRole('button', { name: 'Salva' }).click();
    await expect(page.getByText('Preset «Chat veloce» salvato')).toBeVisible();

    // Started from here first: llama.cpp is installed, then the server answers on its port; stopped.
    await page.getByRole('button', { name: 'Scarica e avvia' }).click();
    await expect(h1(page, /^Server$/)).toBeVisible({ timeout: 90_000 });
    const first = serverCard(page, /Qwen3 0\.6B.*/);
    await expect(first.getByText('Acceso', { exact: true })).toBeVisible({ timeout: 60_000 });
    expect(await cardUrl(first)).toBe(URL);
    await first.getByRole('button', { name: /^Ferma il server / }).click();
    await expect.poll(() => modelsStatus(URL), { timeout: 20_000 }).toBe(0);

    // Then from the preset, with one click, on the same port.
    await page.getByRole('button', { name: 'Avvia il preset Chat veloce' }).click();
    const card = serverCard(page, 'Chat veloce');
    await expect(card.getByText('Acceso', { exact: true })).toBeVisible({ timeout: 60_000 });
    expect(await cardUrl(card)).toBe(URL);
    expect(await modelsStatus(URL)).toBe(200);

    // The tray lists it, says it in the tooltip and copies its address.
    await expectTrayLine(app, new RegExp(`^Chat veloce · porta ${PORT}$`));
    expect(await hook(app, 'trayStatus')).toBe('running');
    expect(await hook(app, 'trayTooltip')).toContain(`1 server attivo: Chat veloce (${PORT})`);
    await app.evaluate(({ clipboard }) => clipboard.writeText(''));
    expect(await hook(app, 'clickTray', `Chat veloce · porta ${PORT}`, 'Copia indirizzo')).toBe(true);
    await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText())).toBe(URL);

    // Closing the window: LLM Bench stays in the tray (said once), the server keeps answering.
    await hook(app, 'closeWindow');
    await expect.poll(async () => (await hook(app, 'notifications')).map((n) => n.body)).toContain('LLM Bench resta attivo nell’area di notifica: il server continua a funzionare.');
    expect(await hook(app, 'windowState')).toMatchObject({ visible: false, destroyed: false });
    expect(await modelsStatus(URL)).toBe(200);

    // "Avvia LLM Bench all'accesso": the login item follows the switch (a file here, never this PC's real one).
    await nav.getByRole('link', { name: 'Impostazioni' }).click();
    await page.getByRole('switch', { name: 'Avvia LLM Bench all’accesso' }).click();
    const loginFile = path.join(userData, 'login-item.json');
    await expect.poll(() => (existsSync(loginFile) ? (JSON.parse(readFileSync(loginFile, 'utf8')) as { openAtLogin?: boolean }).openAtLogin : undefined)).toBe(true);

    // "Esci" from the tray, confirmed: LLM Bench stops its server and quits.
    await hook(app, 'answerQuit', true);
    const exited = new Promise<void>((resolve) => app.process().once('exit', () => resolve()));
    expect(await hook(app, 'clickTray', 'Esci')).toBe(true);
    await exited;
    await expect.poll(() => modelsStatus(URL), { timeout: 20_000 }).toBe(0);
  } finally {
    // Already gone after "Esci"; closed here when a step above failed.
    await gb.close().catch(() => undefined);
  }

  // Next time LLM Bench opens, the preset marked "Avvia all'apertura" starts by itself.
  gb = await launchApp({ env: FAST, userData });
  try {
    const { page, app } = gb;
    await expect(h1(page, 'Benchmark')).toBeVisible();
    await expect(page.getByRole('link', { name: /^Server attivi: 1\. Chat veloce/ })).toBeVisible({ timeout: 60_000 });
    await expect.poll(() => modelsStatus(URL), { timeout: 60_000 }).toBe(200);
    await expectTrayLine(app, new RegExp(`^Chat veloce · porta ${PORT}$`));
  } finally {
    await gb.close();
    rmSync(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
