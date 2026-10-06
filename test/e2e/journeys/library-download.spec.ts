import { expect, launchApp, test } from '../fixtures';
import { h1, openPage, opened, revealed, scan, skipWelcome, startLibraryWorld, stubDesktop, type LibraryWorld } from './library-helpers';

test.describe.configure({ timeout: 150_000 });

let world: LibraryWorld;

test.beforeAll(async () => {
  world = await startLibraryWorld();
});

test.afterAll(async () => {
  await world.close();
});

test('search a model, open it, download the best version with pause and resume, then benchmark it', async () => {
  const gb = await launchApp({ env: world.env });
  try {
    const { page } = gb;
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await stubDesktop(gb);
    await skipWelcome(page);
    await openPage(page, 'Modelli');
    await page.getByRole('tab', { name: 'Scarica' }).click();
    await expect(page.getByRole('heading', { name: 'Trova un modello da provare' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Consigliati per la tua GPU' })).toBeVisible();
    await expect(page.getByText('Scelti per una scheda con 32 GB di memoria video.')).toBeVisible();

    // The catalog shows models before anything is typed, each with its VRAM verdict.
    await expect(page.getByRole('heading', { name: 'I più scaricati su Hugging Face' })).toBeVisible();
    const results = page.getByRole('list', { name: 'Modelli trovati' });
    const qwen = results.getByRole('listitem').filter({ has: page.getByRole('link', { name: 'Qwen3-0.6B-GGUF', exact: true }) });
    await expect(qwen.getByText('Entra perfettamente')).toBeVisible({ timeout: 20_000 });
    await expect(results.getByRole('listitem')).toHaveCount(4);
    await scan(page, 'models catalog');
    // One click on an author shows only their models; one more clears the filter.
    await results.getByRole('button', { name: 'Altri modelli di unsloth' }).click();
    await expect(results.getByRole('listitem')).toHaveCount(1);
    await expect(page.getByText('1 modello', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Togli i filtri' }).click();
    await expect(results.getByRole('listitem')).toHaveCount(4);

    await page.getByRole('searchbox', { name: 'Cerca un modello su Hugging Face' }).fill('qwen3-0.6b');
    await expect(page.getByRole('heading', { name: 'Risultati per «qwen3-0.6b»' })).toBeVisible({ timeout: 20_000 });
    await expect(results.getByRole('listitem')).toHaveCount(1);
    await scan(page, 'search results');
    await results.getByRole('link', { name: 'Qwen3-0.6B-GGUF', exact: true }).click();

    // The model page: best quant preselected, a fit verdict per quant, the card rendered safely.
    await expect(h1(page, 'Qwen3-0.6B-GGUF')).toBeVisible();
    const choices = page.getByRole('radiogroup', { name: 'Scegli la versione da scaricare' });
    await expect(choices.getByRole('radio', { name: /Q8_0/ })).toBeChecked({ timeout: 30_000 });
    await expect(choices.getByText('Consigliata')).toBeVisible();
    await expect(choices.getByText('Entra perfettamente')).toHaveCount(2);
    await expect(page.getByRole('heading', { level: 3, name: 'Qwen3 0.6B GGUF' })).toBeVisible();
    await scan(page, 'model page');
    await page.getByRole('button', { name: 'Apri su Hugging Face' }).click();
    await expect.poll(() => opened(gb)).toEqual(['https://huggingface.co/ggml-org/Qwen3-0.6B-GGUF']);

    // Slow connection: enough time to pause and resume.
    world.hub.behavior.throttleBytesPerSec = 24 * 1024;
    await page.getByRole('button', { name: /^Scarica Q8_0 · / }).click();
    const confirm = page.getByRole('dialog', { name: /^Scaricare Qwen3-0\.6B-GGUF · Q8_0\?$/ });
    await confirm.getByRole('button', { name: /^Scarica · / }).click();
    await page.getByRole('button', { name: 'Vedi i download' }).click();
    const panel = page.getByRole('dialog', { name: 'Download e installazioni' });
    const row = panel.getByRole('listitem').filter({ hasText: 'Qwen3-0.6B-GGUF · Q8_0' });
    await expect(row.getByText('In corso')).toBeVisible({ timeout: 20_000 });
    await scan(page, 'downloads panel');
    await row.getByRole('button', { name: 'Pausa' }).click();
    await expect(row.getByText('In pausa')).toBeVisible();
    world.hub.behavior.throttleBytesPerSec = 0;
    await row.getByRole('button', { name: 'Riprendi' }).click();
    await expect(row.getByText('Completato')).toBeVisible({ timeout: 30_000 });
    await row.getByRole('button', { name: 'Mostra nella cartella' }).click();
    await expect.poll(() => revealed(gb)).toHaveLength(1);
    await panel.getByRole('button', { name: 'Chiudi' }).click();

    // It is now on the PC, ready to benchmark.
    await page.getByRole('link', { name: 'Modelli' }).first().click();
    await expect(page.getByRole('tab', { name: /Sul tuo PC/ })).toBeVisible();
    await page.getByRole('tab', { name: /Sul tuo PC/ }).click();
    const library = page.getByRole('list', { name: 'Sul tuo PC' });
    await expect(library.getByRole('listitem')).toHaveCount(2, { timeout: 20_000 });
    await expect(library.getByText('Qwen3-0.6B-Q8_0', { exact: true })).toBeVisible();
    await scan(page, 'library with the new model');
    await library.getByRole('button', { name: /^Fai il benchmark: .*Q8_0/ }).click();
    await expect(h1(page, 'Benchmark')).toBeVisible();
  } finally {
    world.hub.behavior.throttleBytesPerSec = 0;
    await gb.close();
  }
});

test('delete a model from the library: results stay, other folders are never touched', async () => {
  const gb = await launchApp({ env: world.env });
  try {
    const { page } = gb;
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await stubDesktop(gb);
    await skipWelcome(page);
    await openPage(page, 'Modelli');
    const library = page.getByRole('list', { name: 'Sul tuo PC' });
    await expect(library.getByRole('listitem')).toHaveCount(1, { timeout: 20_000 });
    await library.getByRole('button', { name: /^Mostra nella cartella: / }).click();
    await expect.poll(() => revealed(gb)).toEqual([expect.stringMatching(/Qwen3-0\.6B-Q4_K_M\.gguf$/)]);
    await library.getByRole('button', { name: /^Elimina: / }).click();
    const ask = page.getByRole('alertdialog', { name: /^Eliminare / });
    await expect(ask.getByText(/I risultati dei benchmark fatti con questo modello restano nello storico/)).toBeVisible();
    await scan(page, 'delete confirmation');
    await ask.getByRole('button', { name: 'Elimina' }).click();
    await expect(page.getByRole('heading', { name: 'Nessun modello sul PC' })).toBeVisible();
    await scan(page, 'empty library');
    await page.getByRole('button', { name: 'Scarica un modello' }).click();
    await expect(page.getByRole('heading', { name: 'Consigliati per la tua GPU' })).toBeVisible();
  } finally {
    await gb.close();
  }
});

test('a model with a license to accept: what to do, the token, then it works', async () => {
  const gb = await launchApp({ env: world.env });
  try {
    const { page } = gb;
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await stubDesktop(gb);
    await skipWelcome(page);
    await openPage(page, 'Modelli');
    await page.getByRole('tab', { name: 'Scarica' }).click();
    await page.getByRole('searchbox', { name: 'Cerca un modello su Hugging Face' }).fill('gated');
    await page.getByRole('link', { name: /gated-demo-it/ }).click();
    await expect(h1(page, 'gated-demo-it')).toBeVisible();
    const help = page.getByRole('note').filter({ hasText: 'Questo modello ha una licenza da accettare' });
    await expect(help).toBeVisible({ timeout: 30_000 });
    await scan(page, 'gated model');
    await help.getByRole('button', { name: 'Accetta la licenza su Hugging Face' }).click();
    await expect.poll(() => opened(gb)).toEqual(['https://huggingface.co/google/gated-demo-it']);
    // The user accepts on the website, then pastes the token here.
    world.hub.setAccepted('google/gated-demo-it', true);
    await help.getByLabel('Token di accesso').fill('hf_test_token');
    await help.getByRole('button', { name: 'Salva' }).click();
    const choices = page.getByRole('radiogroup', { name: 'Scegli la versione da scaricare' });
    await expect(choices.getByRole('radio', { name: /Q4_K_M/ })).toBeChecked({ timeout: 30_000 });
    await expect(page.getByText('hf_test_token')).toHaveCount(0);
    await scan(page, 'gated model unlocked');
  } finally {
    world.hub.setAccepted('google/gated-demo-it', false);
    await gb.close();
  }
});
