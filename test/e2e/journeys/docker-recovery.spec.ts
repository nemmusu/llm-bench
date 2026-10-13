/**
 * Docker that is off or stuck, as the user meets it (fake Docker; the real one is never touched):
 * - a server in Docker with Docker off: "Avvia Docker" in the start dialog, then the server starts by itself;
 * - Docker stuck stopping while that server runs (Docker Desktop's cache still answers `docker version`):
 *   the watchdog notices, the tray and the window say "Docker non risponde", "Riavvia Docker" from the
 *   tray brings it back and starts the server again on the same port.
 * Docker Desktop (start, restart, its own status) is what LLM Bench drives on Windows only.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, launchApp, test } from '../fixtures';
import { h1, scan, skipWelcome } from './bench-helpers';
import { cardUrl, expectTrayLine, hook, modelsStatus, serverCard } from './server-helpers';

test.describe.configure({ timeout: 240_000 });
test.skip(process.platform !== 'win32', 'Docker Desktop is started and restarted from LLM Bench on Windows only');

const FAST = { FAKE_ENGINE_PROFILE: JSON.stringify({ loadMsWarm: 300, loadMsCold: 300, prefillTps: 15000, decodeTps: 1500, tokensPerChunk: 4 }) };
/** A stuck Docker found in about a second instead of minutes; a restart polled quickly. */
const TIMINGS = { GPUBENCH_DOCKER_TIMINGS: JSON.stringify({ activeEveryMs: 400, idleEveryMs: 800, stuckStoppingMs: 300, desktopStatusEveryMs: 200, startPollMs: 200, restartWaitMs: 30_000 }) };
const PORT = 18441;
const URL = `http://127.0.0.1:${PORT}/v1`;

/** Switches the fake Docker while the app runs (fake-docker.mjs reads <state>/mode.json at every call). */
function setDocker(userData: string, mode: Record<string, unknown>): void {
  const dir = path.join(userData, 'fake-docker');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'mode.json'), JSON.stringify(mode));
}

test('Docker off: "Avvia Docker" in the start dialog, then the server starts; Docker stuck: told, restarted from the tray, the server back on its port', async () => {
  const gb = await launchApp({ env: { ...FAST, ...TIMINGS } });
  try {
    const { page, app, userData } = gb;
    setDocker(userData, { mode: 'daemon-down' });
    await skipWelcome(page);
    // The tray offers to start it.
    await expectTrayLine(app, /^Docker: spento$/);
    await expectTrayLine(app, /^Avvia Docker$/);

    // A llama.cpp server in Docker, on a port of its own.
    const nav = page.getByRole('navigation', { name: 'Navigazione principale' });
    await nav.getByRole('link', { name: 'Server', exact: true }).click();
    await page.getByRole('link', { name: 'Avvia un server' }).first().click();
    await expect(h1(page, 'Avvia un server')).toBeVisible();
    await page.getByRole('combobox', { name: 'Motore' }).click();
    await page.getByRole('option', { name: /llama\.cpp \(Docker\)/ }).click();
    await page.getByRole('tab', { name: 'Comandi personalizzati' }).click();
    await page.getByRole('textbox', { name: 'Porta' }).fill(String(PORT));
    await expect(page.getByRole('region', { name: 'Comando esatto' })).toContainText(String(PORT), { timeout: 30_000 });
    await page.getByRole('button', { name: /^(Avvia|Scarica e avvia)$/ }).click();

    // Docker is off: said in the same dialog, with the button; then it carries on by itself.
    const gate = page.getByRole('dialog', { name: 'Docker è spento' });
    await expect(gate.getByText(/gira dentro Docker/)).toBeVisible({ timeout: 30_000 });
    await scan(page, 'docker off in the start dialog');
    await gate.getByRole('button', { name: 'Avvia Docker' }).click();
    await expect(h1(page, /^Server$/)).toBeVisible({ timeout: 90_000 });
    const card = serverCard(page, /Qwen3 0\.6B.*/);
    await expect(card.getByText('Acceso', { exact: true })).toBeVisible({ timeout: 60_000 });
    expect(await cardUrl(card)).toBe(URL);
    await expectTrayLine(app, /^Docker: acceso$/);
    expect(readFileSync(path.join(userData, 'fake-docker', 'desktop.log'), 'utf8')).toContain('start --detach');

    // Docker gets stuck stopping: its cache still answers `docker version`, its own status says "stopping".
    setDocker(userData, { mode: 'stuck' });
    await expect(page.getByRole('alert').getByText('Docker non risponde')).toBeVisible({ timeout: 30_000 });
    await expectTrayLine(app, /^Docker: non risponde$/);
    await expect.poll(async () => (await hook(app, 'notifications')).map((n) => n.title), { timeout: 20_000 }).toContain('Docker non risponde');
    expect(await hook(app, 'trayTooltip')).toContain('Docker non risponde');
    await scan(page, 'docker not responding banner');

    // "Riavvia Docker" from the tray: Docker Desktop's own restart, then the server again on its port.
    expect(await hook(app, 'clickTray', 'Riavvia Docker')).toBe(true);
    await expect(page.getByRole('alert')).toHaveCount(0, { timeout: 60_000 });
    await expectTrayLine(app, /^Docker: acceso$/);
    const again = serverCard(page, /Qwen3 0\.6B.*/);
    await expect(again.getByText('Acceso', { exact: true })).toBeVisible({ timeout: 90_000 });
    expect(await cardUrl(again)).toBe(URL);
    await expect.poll(() => modelsStatus(URL), { timeout: 30_000 }).toBe(200);
    expect(readFileSync(path.join(userData, 'fake-docker', 'desktop.log'), 'utf8')).toContain('restart');

    await again.getByRole('button', { name: /^Ferma il server / }).click();
    await expect.poll(() => modelsStatus(URL), { timeout: 20_000 }).toBe(0);
  } finally {
    await gb.close();
  }
});

test('Docker that does not answer at all: the banner with why and how to avoid it, the restart in its dialog', async () => {
  const gb = await launchApp({ env: { ...TIMINGS, GPUBENCH_DOCKER_TIMINGS: JSON.stringify({ versionTimeoutMs: 1500, idleEveryMs: 500, startPollMs: 200, restartWaitMs: 30_000 }) } });
  try {
    const { page, app, userData } = gb;
    await skipWelcome(page);
    setDocker(userData, { mode: 'hung' });
    // Two `docker version` calls without an answer: not responding.
    const banner = page.getByRole('alert');
    await expect(banner.getByText('Docker non risponde')).toBeVisible({ timeout: 60_000 });
    await banner.getByRole('button', { name: 'Perché e come evitarlo' }).click();
    const dialog = page.getByRole('dialog', { name: 'Docker non risponde' });
    await expect(dialog.getByText('Docker è acceso ma non risponde ai comandi.')).toBeVisible({ timeout: 30_000 });
    await scan(page, 'docker not responding dialog');
    await dialog.getByRole('button', { name: 'Riavvia Docker' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0, { timeout: 60_000 });
    await expect(page.getByRole('alert')).toHaveCount(0, { timeout: 30_000 });
    await expectTrayLine(app, /^Docker: acceso$/);
  } finally {
    await gb.close();
  }
});
