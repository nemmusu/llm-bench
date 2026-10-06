import { expect, launchApp, test } from '../fixtures';
import { startFakeEngine } from '../../fakes/fake-engine/server.mjs';
import { h1, scan, setGpuState, skipWelcome } from './bench-helpers';

test.describe.configure({ timeout: 150_000 });

test('cancel a run: confirmation, then the saved result says it was cancelled', async () => {
  // Slow generation: the run is still going when the user changes their mind.
  const gb = await launchApp({ env: { FAKE_ENGINE_PROFILE: JSON.stringify({ loadMsCold: 800, loadMsWarm: 400, prefillTps: 9000, decodeTps: 12 }) } });
  try {
    const { page } = gb;
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await skipWelcome(page);
    await page.getByRole('button', { name: 'Avvia benchmark' }).click();
    await page.getByRole('button', { name: 'Scarica e avvia' }).click();
    await expect(h1(page, 'Test in corso')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText('Il modello sta scrivendo testo di prova.', { exact: false })).toBeVisible({ timeout: 30_000 });
    await page.getByRole('button', { name: 'Mostra il log del server' }).click();
    await expect(page.getByRole('region', { name: 'Log del server' })).toContainText('llama');

    await page.getByRole('button', { name: 'Annulla test' }).click();
    const ask = page.getByRole('alertdialog', { name: 'Vuoi annullare il test?' });
    await scan(page, 'cancel confirmation');
    await ask.getByRole('button', { name: 'Continua il test' }).click();
    await expect(h1(page, 'Test in corso')).toBeVisible();
    await page.getByRole('button', { name: 'Annulla test' }).click();
    await page.getByRole('button', { name: 'Annulla il test' }).click();

    await expect(h1(page, /Qwen3-0\.6B/)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText('Annullato', { exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Operazione annullata' })).toBeVisible();
    // "Riprova" runs the same benchmark again.
    await page.getByRole('button', { name: 'Riprova' }).click();
    await expect(h1(page, 'Test in corso')).toBeVisible({ timeout: 30_000 });
    await page.getByRole('button', { name: 'Annulla test' }).click();
    await page.getByRole('button', { name: 'Annulla il test' }).click();
    await expect(page.getByText('Annullato', { exact: true })).toBeVisible({ timeout: 30_000 });
  } finally {
    await gb.close();
  }
});

test('the engine runs out of graphics memory: the error says what to do', async () => {
  const gb = await launchApp({ env: { FAKE_ENGINE_PROFILE: JSON.stringify({ oomAtLoad: true, loadMsWarm: 300 }) } });
  try {
    const { page } = gb;
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await skipWelcome(page);
    await page.getByRole('button', { name: 'Avvia benchmark' }).click();
    await page.getByRole('button', { name: 'Scarica e avvia' }).click();
    await expect(page.getByText('Non riuscito', { exact: true })).toBeVisible({ timeout: 60_000 });
    await expect(page.getByRole('heading', { name: 'Memoria della scheda video insufficiente' })).toBeVisible();
    await page.getByText('Dettagli tecnici').click();
    await expect(page.getByText(/ENGINE_OOM:/)).toBeVisible();
    await scan(page, 'oom result');
    await page.getByRole('button', { name: 'Apri il log' }).click();
    await expect(page.getByRole('region', { name: 'Log del server (estratto)' })).toContainText(/out of memory/i);
    await page.getByRole('tab', { name: 'Panoramica' }).click();
    await page.getByRole('button', { name: 'Scegli un altro modello' }).click();
    await expect(h1(page, 'Benchmark')).toBeVisible();
  } finally {
    await gb.close();
  }
});

test('an external server (expert mode): no engine to install, loading not measured', async () => {
  const engine = await startFakeEngine({ flavor: 'llamacpp', alias: 'demo-model', profile: { decodeTps: 900, prefillTps: 15000, loadMsWarm: 50 } });
  const gb = await launchApp();
  try {
    const { page } = gb;
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await skipWelcome(page);
    await page.getByRole('switch', { name: 'Modalità esperto' }).click();
    await page.getByRole('combobox', { name: 'Cambia motore' }).click();
    await page.getByRole('option', { name: /Server esterno/ }).click();
    await expect(page.getByRole('group', { name: 'Server esterno' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Avvia benchmark' })).toBeDisabled();
    await page.getByLabel('Indirizzo del server').fill('non è un indirizzo');
    await expect(page.getByText('Valore non valido: lo ignoro finché non lo correggi.')).toBeVisible();
    await page.getByLabel('Indirizzo del server').fill(engine.url);
    await page.getByLabel('Nome del modello').fill('demo-model');
    await page.getByLabel('Chiave API').fill('sk-test-only');
    await page.getByRole('combobox', { name: 'Tipo di server' }).click();
    await page.getByRole('option', { name: 'llama.cpp' }).click();
    await expect(page.getByText('Modello «demo-model» del server')).toBeVisible();
    await expect(page.getByText('Caricamento non misurabile')).toBeVisible({ timeout: 15_000 });
    await scan(page, 'external endpoint');

    await page.getByRole('button', { name: 'Avvia benchmark' }).click();
    await expect(h1(page, /demo-model/)).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText('Completato', { exact: true })).toBeVisible();
    await page.getByRole('tab', { name: 'Come è stato avviato' }).click();
    await expect(page.getByRole('button', { name: 'Avvia solo il server così' })).toBeHidden();
    await page.getByRole('button', { name: 'Mostra comando' }).click();
    await expect(page.getByText('Il server era già acceso: GPU Bench non ha avviato nessun comando.')).toBeVisible();
  } finally {
    await gb.close();
    await engine.close();
  }
});

test('the GPU is busy with another LLM server: ask before measuring', async () => {
  const gb = await launchApp({ env: { FAKE_ENGINE_PROFILE: JSON.stringify({ loadMsWarm: 300, prefillTps: 15000, decodeTps: 1500, tokensPerChunk: 4 }) } });
  try {
    const { page, userData } = gb;
    await page.emulateMedia({ reducedMotion: 'reduce' });
    setGpuState(userData, { gpus: [{ memUsedMiB: 9800, powerW: 60, utilPct: 3, tempC: 45 }], apps: [{ pid: 4242, name: 'llama-server.exe', usedMiB: 8200 }] });
    await skipWelcome(page);
    // Install llama.cpp with a first start, then back out at the GPU question.
    await page.getByRole('button', { name: 'Avvia benchmark' }).click();
    await page.getByRole('button', { name: 'Scarica e avvia' }).click();
    const busy = page.getByRole('dialog', { name: 'La scheda video è già occupata' });
    await expect(busy).toBeVisible({ timeout: 30_000 });
    await expect(busy.getByText(/llama-server\.exe/)).toBeVisible();
    await scan(page, 'gpu busy dialog');
    await busy.getByRole('button', { name: 'Annulla' }).click();
    await expect(busy).toBeHidden();

    // The preview warns too; this time continue anyway.
    await expect(page.getByText('Altri server stanno usando la scheda video')).toBeVisible({ timeout: 15_000 });
    await page.getByRole('button', { name: 'Avvia benchmark' }).click();
    await page.getByRole('button', { name: 'Continua comunque' }).click();
    await expect(h1(page, /Qwen3-0\.6B/)).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText('Altri programmi stavano usando la GPU')).toBeVisible();
    await expect(page.getByText(/llama-server\.exe \(PID 4242/)).toBeVisible();
  } finally {
    await gb.close();
  }
});
