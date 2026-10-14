import { expect, test } from '../fixtures';
import { launchApp } from '../fixtures';
import { h1, scan, skipWelcome } from './bench-helpers';

test.describe.configure({ timeout: 180_000 });

/** A fast fake engine: the Standard profile finishes in a few seconds. */
const FAST = JSON.stringify({ loadMsCold: 900, loadMsWarm: 300, prefillTps: 20000, decodeTps: 1500, tokensPerChunk: 4 });

test('standard run: cold and warm loads, long prompts and several users; then run it again', async () => {
  const gb = await launchApp({ env: { FAKE_ENGINE_PROFILE: FAST } });
  try {
    const { page } = gb;
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await skipWelcome(page);
    await page.getByRole('radio', { name: /Standard/ }).click();
    await expect(page.getByText(/Caricamento a freddo e a caldo/)).toBeVisible();
    await page.getByRole('button', { name: 'Avvia benchmark' }).click();
    await page.getByRole('button', { name: 'Scarica e avvia' }).click();
    await expect(h1(page, 'Test in corso')).toBeVisible({ timeout: 30_000 });
    for (const phase of ['A freddo', 'A caldo', 'Lettura prompt', 'Generazione', 'Più utenti']) {
      await expect(page.getByRole('list', { name: 'Fasi del test' }).getByText(phase)).toBeVisible();
    }
    await expect(h1(page, /Qwen3-0\.6B/)).toBeVisible({ timeout: 90_000 });

    const kpis = page.getByRole('region', { name: 'Numeri principali' });
    await expect(kpis.getByText('Caricamento a freddo')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Più utenti insieme' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Velocità per lunghezza del testo' })).toBeVisible();
    await page.getByRole('radio', { name: 'Lettura prompt' }).click();
    await page.getByRole('button', { name: 'Mostra tabella' }).first().click();
    await expect(page.getByRole('table', { name: /Velocità per lunghezza del testo/ })).toContainText('4.096');

    await page.getByRole('tab', { name: 'Dettagli' }).click();
    const conc = page.getByRole('table', { name: 'Più utenti' });
    await expect(conc.getByRole('row')).toHaveCount(5);
    await expect(page.getByRole('table', { name: 'Caricamento del modello' })).toContainText('A freddo');
    await expect(page.getByRole('table', { name: 'Memoria video' })).toBeVisible();
    await scan(page, 'result details');

    await page.getByRole('tab', { name: 'Log' }).click();
    await expect(page.getByRole('region', { name: 'Log del server (estratto)' })).toContainText('slot');
    // Requests never push the engine start out of the excerpt: the load lines stay.
    await expect(page.getByRole('region', { name: 'Log del server (estratto)' })).toContainText('load_tensors: offloaded');

    // Run it again, same settings: no download this time, straight to the live screen.
    await page.getByRole('tab', { name: 'Come è stato avviato' }).click();
    await page.getByRole('button', { name: 'Rifai questo benchmark' }).click();
    await expect(h1(page, 'Test in corso')).toBeVisible({ timeout: 30_000 });
    await expect(h1(page, /Qwen3-0\.6B/)).toBeVisible({ timeout: 90_000 });

    await page.getByRole('link', { name: 'Tutti i risultati' }).click();
    await expect(page.getByText('2 risultati')).toBeVisible();
  } finally {
    await gb.close();
  }
});

test('expert mode: custom plan and launch parameters, exact command, settings reused from a result', async () => {
  const gb = await launchApp({ env: { FAKE_ENGINE_PROFILE: FAST } });
  try {
    const { page } = gb;
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await skipWelcome(page);
    await page.getByRole('switch', { name: 'Modalità esperto' }).click();
    await expect(page.getByRole('heading', { name: 'Parametri avanzati' })).toBeVisible();
    await expect(page.getByText('llama.cpp non è ancora installato: il comando usa già la cartella dove lo installerò prima del test.')).toBeVisible();
    await expect(page.getByRole('region', { name: 'Anteprima comando' })).toContainText('llama-server');

    await page.getByRole('radio', { name: /Personalizzato/ }).click();
    await page.getByLabel('Caricamenti a freddo').fill('0');
    await page.getByLabel('Caricamenti a caldo').fill('1');
    await page.getByLabel('Lunghezze dei prompt').fill('256, abc');
    await expect(page.getByText('Valore non valido: correggilo per poter avviare.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Avvia benchmark' })).toBeDisabled();
    await page.getByLabel('Lunghezze dei prompt').fill('256');
    await page.getByLabel('Token generati').fill('64');
    await page.getByLabel('Ripetizioni', { exact: true }).fill('2');
    await page.getByLabel('Utenti contemporanei').fill('2');
    await page.getByLabel('Contesto (token)').fill('4096');
    await page.getByLabel('Variabili d’ambiente').fill('GGML_CUDA_FORCE_MMQ=1');
    await page.getByLabel('Argomenti extra').fill('--metrics');
    await scan(page, 'expert panel');

    await page.getByRole('button', { name: 'Avvia benchmark' }).click();
    await page.getByRole('button', { name: 'Scarica e avvia' }).click();
    await expect(h1(page, /Qwen3-0\.6B/)).toBeVisible({ timeout: 90_000 });
    await expect(page.getByText('Personalizzato', { exact: true })).toBeVisible();

    await page.getByRole('tab', { name: 'Come è stato avviato' }).click();
    // The header says the configuration too: the sentence of this tab is the one checked here.
    const launch = page.getByRole('tabpanel', { name: 'Come è stato avviato' });
    await expect(launch.getByText('contesto 4.096')).toBeVisible();
    await expect(launch.getByText('argomenti extra: --metrics')).toBeVisible();
    await page.getByRole('button', { name: 'Mostra comando' }).click();
    await page.getByRole('radio', { name: 'bash' }).click();
    await expect(page.getByRole('region', { name: 'Comando' })).toContainText('GGML_CUDA_FORCE_MMQ=1');

    // Back to the Benchmark page with these settings: the plan preview shows the exact command.
    await page.getByRole('button', { name: 'Usa queste impostazioni' }).click();
    await expect(h1(page, 'Benchmark')).toBeVisible();
    await expect(page.getByText('Impostazioni copiate nel Benchmark')).toBeVisible();
    await expect(page.getByLabel('Contesto (token)')).toHaveValue('4096');
    await expect(page.getByRole('radio', { name: /Personalizzato/ })).toBeChecked();
    await expect(page.getByRole('region', { name: 'Anteprima comando' })).toContainText('--metrics');
    await expect(page.getByText('Cosa misuro')).toBeVisible();

    // Leaving expert mode hides the custom plan and falls back to the Quick profile.
    await page.getByRole('switch', { name: 'Modalità esperto' }).click();
    await expect(page.getByRole('radio', { name: /Rapido/ })).toBeChecked();
  } finally {
    await gb.close();
  }
});
