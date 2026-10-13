import { expect, launchApp, test } from '../fixtures';
import { scan, skipWelcome } from './bench-helpers';
import { openPage } from './library-helpers';

test.describe.configure({ timeout: 150_000 });

const FAST_ENGINE = { FAKE_ENGINE_PROFILE: JSON.stringify({ loadMsWarm: 300, loadMsCold: 300, prefillTps: 15000, decodeTps: 1500, tokensPerChunk: 4 }) };

test('start only the server from the Benchmark page: what will run, the address, the running list, Stop', async () => {
  const gb = await launchApp({ env: FAST_ENGINE });
  try {
    const { page, app } = gb;
    await skipWelcome(page);
    await expect(page.getByRole('button', { name: /Cambia modello: Qwen3 0\.6B/ })).toBeVisible();

    // One click, then one clear confirmation: how much text it takes, whether it fits, what is installed first, the command.
    await page.getByRole('button', { name: 'Avvia solo il server', exact: true }).click();
    const confirm = page.getByRole('dialog', { name: 'Avvia il server' });
    await expect(confirm.getByText('32.768 token')).toBeVisible({ timeout: 30_000 });
    await expect(confirm.getByText(/L’ho scelto perché entri bene nella tua scheda video/)).toBeVisible();
    await expect(confirm.getByText('Entra perfettamente')).toBeVisible();
    await expect(confirm.getByText('Installo llama.cpp')).toBeVisible();
    const command = confirm.getByRole('region', { name: 'Comando esatto' });
    await expect(command).toContainText('-c 32768');
    await expect(command).toContainText('Qwen3-0.6B-Q4_K_M.gguf');
    await scan(page, 'server confirmation');
    await confirm.getByRole('button', { name: 'Avvia server' }).click();

    // llama.cpp is installed first, then the server answers at its address.
    const ready = page.getByRole('dialog', { name: 'Il server è pronto' });
    await expect(ready.getByText('Indirizzo compatibile OpenAI')).toBeVisible({ timeout: 90_000 });
    await expect(ready.getByText(/Contesto 32\.768 token/)).toBeVisible();
    await scan(page, 'server ready');
    const url = (await ready.getByText(/^http:\/\/127\.0\.0\.1:\d+\/v1$/).textContent())!;
    await app.evaluate(({ clipboard }) => clipboard.writeText(''));
    await ready.getByRole('button', { name: 'Copia l’indirizzo compatibile OpenAI' }).click();
    await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText())).toBe(url);
    // Other programs really can talk to it.
    expect((await fetch(`${url}/models`)).status).toBe(200);
    await ready.getByRole('button', { name: 'Lascia acceso' }).click();
    await expect(ready).toBeHidden();

    // The Benchmark page lists it with its context, and stops it.
    await expect(page.getByRole('heading', { name: 'Server attivi' })).toBeVisible();
    await expect(page.getByText('Contesto 32.768 token')).toBeVisible();
    await scan(page, 'running server with its context');
    await page.getByRole('button', { name: /Ferma il server di/ }).click();
    await expect(page.getByText(/fermato/)).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Server attivi' })).toBeHidden();
    await expect.poll(() => fetch(`${url}/models`).then((r) => r.status, () => 0)).toBe(0);
  } finally {
    await gb.close();
  }
});

test('Models → Sul tuo PC → Avvia server: a model on the PC served with the recommended settings', async () => {
  const gb = await launchApp({ env: FAST_ENGINE });
  try {
    const { page } = gb;
    await skipWelcome(page);
    await openPage(page, 'Modelli');
    const list = page.getByRole('list', { name: 'Per llama.cpp (GGUF)' });
    await list.getByRole('button', { name: /^Avvia server: Qwen3/ }).click();
    const confirm = page.getByRole('dialog', { name: 'Avvia il server' });
    await expect(confirm.getByText('32.768 token')).toBeVisible({ timeout: 30_000 });
    await expect(confirm.getByText(/con llama\.cpp\. Altri programmi potranno usarlo/)).toBeVisible();
    await scan(page, 'server confirmation from Models');
    await confirm.getByRole('button', { name: 'Avvia server' }).click();
    const ready = page.getByRole('dialog', { name: 'Il server è pronto' });
    await expect(ready.getByText('Indirizzo compatibile OpenAI')).toBeVisible({ timeout: 90_000 });
    await ready.getByRole('button', { name: 'Ferma' }).click();
    await expect(page.getByText(/fermato/)).toBeVisible();
    await expect(ready).toBeHidden();
  } finally {
    await gb.close();
  }
});
