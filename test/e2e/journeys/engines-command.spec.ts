/**
 * A program with an OpenAI API, as a person meets it: added on the Engines page with a command before
 * the server, the server (the fake engine in vLLM mode stands in for the user's program) taking {ctx}
 * and {kv}, and a command after it; benchmarked with only its own settings in expert mode; the commands
 * before and after really run around every start and stop. A command before that fails stops the test
 * with a message that names it.
 *
 * GPUBENCH_QA_SHOTS=<folder>: screenshots of the dialog and the Benchmark (1024 px and full screen,
 * light and dark, Italian and English) for a visual check.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { TUNE_PROFILE } from '../../fakes/fake-engine/profiles.mjs';
import { expect, launchApp, ROOT, test, type AppHandle } from '../fixtures';
import { h1, scan, skipWelcome } from './bench-helpers';
import { openPage, startLibraryWorld, type LibraryWorld } from './library-helpers';

test.describe.configure({ timeout: 240_000 });

const CLI = path.join(ROOT, 'test', 'fakes', 'fake-engine', 'cli.mjs');
const NODE = process.execPath;
const SHOTS = process.env.GPUBENCH_QA_SHOTS;

let world: LibraryWorld;
let dir: string;

test.beforeAll(async () => {
  world = await startLibraryWorld();
  dir = mkdtempSync(path.join(os.tmpdir(), 'gpubench-e2e-steps-'));
  // A command before: says what it does and leaves a mark with the values it got; one after: its own mark.
  writeFileSync(path.join(dir, 'before.mjs'), "import { appendFileSync } from 'node:fs';\nconsole.log(`preparing ${process.argv.slice(2).join(' ')}`);\nappendFileSync(process.env.MARKS, `before ${process.argv.slice(2).join(' ')}\\n`);\n");
  writeFileSync(path.join(dir, 'after.mjs'), "import { appendFileSync } from 'node:fs';\nconsole.log('cleaning up');\nappendFileSync(process.env.MARKS, 'after\\n');\n");
  writeFileSync(path.join(dir, 'broken.mjs'), "console.error('the environment is not ready');\nprocess.exit(3);\n");
});

test.afterAll(async () => {
  await world.close();
  rmSync(dir, { recursive: true, force: true });
});

const q = (s: string) => `"${s}"`;
const SERVER = `${q(NODE)} ${q(CLI)} serve {model} --port {port} --served-model-name {alias} --max-model-len {ctx} --kv-cache-dtype {kv}`;

async function resize(gb: AppHandle, width: number, height: number): Promise<void> {
  await gb.app.evaluate(({ BrowserWindow }, s) => BrowserWindow.getAllWindows()[0]?.setContentSize(s.width, s.height), { width, height });
}

async function shot(gb: AppHandle, name: string): Promise<void> {
  if (!SHOTS) return;
  // Two frames: the last change painted.
  await gb.page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(null)))));
  await gb.page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
}

/** "Aggiungi motore" → a program with an OpenAI API, at "Dove si trova". */
async function addProgram(page: Page, name: string, labels = { add: 'Aggiungi motore', dialog: 'Aggiungi un motore', kind: /Programma con API OpenAI/, next: 'Avanti', name: 'Nome' }) {
  await page.getByRole('button', { name: labels.add }).click();
  const dialog = page.getByRole('dialog', { name: labels.dialog });
  await dialog.getByRole('radio', { name: labels.kind }).click();
  await dialog.getByRole('button', { name: labels.next }).click();
  await dialog.getByLabel(labels.name, { exact: true }).fill(name);
  return dialog;
}

test('a program with an OpenAI API: commands before and after its server, {ctx} and {kv}, measured and stopped', async () => {
  const marks = path.join(dir, 'marks.txt');
  const gb = await launchApp({ env: { ...world.env, MARKS: marks } });
  try {
    const { page } = gb;
    await skipWelcome(page);
    await openPage(page, 'Motori');
    const dialog = await addProgram(page, 'Il mio server');
    await dialog.getByLabel('Comando che avvia il server').fill(SERVER);
    // {kv}: the types it takes (vLLM's names).
    const kv = dialog.getByRole('group', { name: 'Tipi di cache KV che accetta al posto di {kv}' });
    for (const k of ['f16', 'q8_0', 'q4_0', 'auto', 'fp8']) await kv.getByRole('checkbox', { name: k, exact: true }).click();
    await dialog.getByRole('button', { name: '+ Comandi prima o dopo il server (facoltativi)' }).click();
    await dialog.getByLabel('Prima di ogni avvio').fill(`${q(NODE)} ${q(path.join(dir, 'before.mjs'))} {ctx} {kv}`);
    await dialog.getByLabel('Dopo ogni arresto').fill(`${q(NODE)} ${q(path.join(dir, 'after.mjs'))}`);
    // Every command filled in with example values, while typing.
    const preview = dialog.getByRole('region', { name: 'I comandi con valori di esempio' });
    await expect(preview).toContainText('--kv-cache-dtype auto');
    await expect(preview).toContainText('# prima del server');
    await expect(dialog.getByText(/Impostazioni di LLM Bench che usa: Contesto \(token\), Tipo di cache KV\./)).toBeVisible();
    await dialog.getByRole('button', { name: 'Prova' }).click();
    await expect(dialog.getByText(`Programmi trovati (3 comandi): il server è ${NODE}`)).toBeVisible({ timeout: 30_000 });
    await scan(page, 'add engine: program with steps');
    await dialog.getByRole('button', { name: 'Avanti' }).click();
    await dialog.getByRole('button', { name: 'Salva motore' }).click();
    await expect(dialog).toBeHidden();
    const card = page.getByRole('region', { name: 'Il mio server' });
    await expect(card.getByText('prima del server')).toBeVisible();
    await card.getByRole('button', { name: 'Usa nel Benchmark' }).click();

    // The Benchmark: only its settings, the search offered (it takes {ctx}).
    await expect(h1(page, 'Benchmark')).toBeVisible();
    await expect(page.getByRole('combobox', { name: 'Cambia motore' })).toContainText('Programma con API OpenAI · Il mio server');
    await expect(page.getByRole('radio', { name: /Trova le impostazioni migliori/ })).toBeVisible();
    await page.getByRole('switch', { name: 'Modalità esperto' }).click();
    const settings = page.getByRole('group', { name: 'Impostazioni di Il mio server' });
    await expect(settings.getByLabel('Contesto (token)')).toBeVisible();
    await expect(page.getByLabel('Flash attention')).toHaveCount(0);
    await settings.getByLabel('Contesto (token)').fill('8192');
    await settings.getByRole('combobox', { name: 'Tipo di cache KV' }).click();
    await page.getByRole('option', { name: 'fp8', exact: true }).click();
    const command = page.getByRole('region', { name: 'Anteprima comando' });
    await expect(command).toContainText('before.mjs', { timeout: 30_000 });
    await expect(command).toContainText('--max-model-len 8192');
    await expect(command).toContainText('after.mjs');
    await scan(page, 'benchmark with a program');
    await page.getByRole('button', { name: 'Avvia benchmark' }).click();
    await expect(h1(page, 'Test in corso')).toBeVisible({ timeout: 60_000 });
    await expect(h1(page, /Qwen3-0\.6B-Q4_K_M/)).toBeVisible({ timeout: 150_000 });
    await expect(page.getByText('Completato', { exact: true })).toBeVisible();
    // The command before got the run's values before every start; the one after ran after every stop.
    const lines = readFileSync(marks, 'utf8').trim().split('\n');
    expect(lines[0]).toBe('before 8192 fp8');
    expect(lines.filter((l) => l === 'after')).toHaveLength(lines.filter((l) => l.startsWith('before')).length);
    await page.getByRole('tab', { name: 'Come è stato avviato' }).click();
    await page.getByRole('button', { name: 'Mostra comando' }).click();
    await expect(page.getByRole('region', { name: 'Comando' })).toContainText('# before the server');
    await scan(page, 'result of a program with steps');
  } finally {
    await gb.close();
  }
});

test('"Trova le impostazioni migliori" on a program that takes {ctx}, {kv} and {batch}: contexts, KV types and batch tried', async () => {
  const marks = path.join(dir, 'tune-marks.txt');
  const gb = await launchApp({ env: { ...world.env, MARKS: marks, FAKE_ENGINE_PROFILE: JSON.stringify(TUNE_PROFILE) } });
  try {
    const { page } = gb;
    await skipWelcome(page);
    await openPage(page, 'Motori');
    const dialog = await addProgram(page, 'Simile a llama');
    // The fake engine in vLLM mode: its two KV types, the batched tokens.
    await dialog.getByLabel('Comando che avvia il server').fill(`${SERVER} --max-num-batched-tokens {batch}`);
    const kv = dialog.getByRole('group', { name: 'Tipi di cache KV che accetta al posto di {kv}' });
    for (const k of ['f16', 'q8_0', 'q4_0', 'auto', 'fp8']) await kv.getByRole('checkbox', { name: k, exact: true }).click();
    await dialog.getByRole('button', { name: '+ Comandi prima o dopo il server (facoltativi)' }).click();
    await dialog.getByLabel('Prima di ogni avvio').fill(`${q(NODE)} ${q(path.join(dir, 'before.mjs'))} {ctx} {kv}`);
    await dialog.getByRole('button', { name: 'Avanti' }).click();
    await dialog.getByRole('button', { name: 'Salva motore' }).click();
    await page.getByRole('region', { name: 'Simile a llama' }).getByRole('button', { name: 'Usa nel Benchmark' }).click();
    await expect(h1(page, 'Benchmark')).toBeVisible();
    await page.getByRole('radio', { name: /Trova le impostazioni migliori/ }).click();
    await page.getByRole('button', { name: 'Avvia benchmark' }).click();
    await expect(h1(page, 'Test in corso')).toBeVisible({ timeout: 60_000 });
    await expect(h1(page, /Qwen3-0\.6B/)).toBeVisible({ timeout: 200_000 });
    const recommended = page.getByRole('region', { name: 'Combinazione consigliata' });
    await expect(recommended.getByText(/Cache KV (auto|fp8)/)).toBeVisible();
    // Every launch got its own context and KV type through the command before the server too.
    const tried = new Set(readFileSync(marks, 'utf8').trim().split('\n').map((l) => l.split(' ')[2]));
    expect([...tried].sort()).toEqual(['auto', 'fp8']);
    await scan(page, 'tune result of a program');
  } finally {
    await gb.close();
  }
});

test('a command before the server that fails stops the test and says which one', async () => {
  const gb = await launchApp({ env: world.env, settings: { expertMode: false } });
  try {
    const { page } = gb;
    await skipWelcome(page);
    await openPage(page, 'Motori');
    const dialog = await addProgram(page, 'Rotto');
    await dialog.getByLabel('Comando che avvia il server').fill(SERVER.replace(' --kv-cache-dtype {kv}', ''));
    await dialog.getByRole('button', { name: '+ Comandi prima o dopo il server (facoltativi)' }).click();
    await dialog.getByLabel('Prima di ogni avvio').fill(`${q(NODE)} ${q(path.join(dir, 'broken.mjs'))}`);
    await dialog.getByRole('button', { name: 'Avanti' }).click();
    await dialog.getByRole('button', { name: 'Salva motore' }).click();
    await page.getByRole('region', { name: 'Rotto' }).getByRole('button', { name: 'Usa nel Benchmark' }).click();
    await expect(h1(page, 'Benchmark')).toBeVisible();
    await page.getByRole('button', { name: 'Avvia benchmark' }).click();
    await expect(page.getByText(`Il comando 1 prima del server (${path.basename(NODE)}) è finito con un errore (codice 3)`, { exact: false })).toBeVisible({ timeout: 90_000 });
    await scan(page, 'a command before that failed');
  } finally {
    await gb.close();
  }
});

// Only for a visual check: defined when GPUBENCH_QA_SHOTS names a folder.
if (SHOTS) test('screenshots for a visual check (GPUBENCH_QA_SHOTS)', async () => {
  for (const [lang, theme] of [
    ['it', 'light'],
    ['en', 'dark'],
  ] as const) {
    const gb = await launchApp({ env: world.env, settings: { language: lang, theme, onboardingDone: true } });
    try {
      const { page } = gb;
      await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
      const en = lang === 'en';
      await openPage(page, en ? 'Engines' : 'Motori');
      for (const [w, h] of [
        [1024, 720],
        [1600, 1000],
      ] as const) {
        await resize(gb, w, h);
        const dialog = await addProgram(
          page,
          en ? 'My server' : 'Il mio server',
          en ? { add: 'Add engine', dialog: 'Add an engine', kind: /Program with an OpenAI API/, next: 'Next', name: 'Name' } : undefined,
        );
        await shot(gb, `${lang}-${theme}-${w}-empty`);
        await dialog.getByRole('button', { name: en ? 'A Python script, with preparation and clean-up' : 'Uno script Python, con preparazione e pulizia' }).click();
        await shot(gb, `${lang}-${theme}-${w}-python`);
        await dialog.getByRole('button', { name: en ? 'A server like llama.cpp' : 'Un server come llama.cpp' }).click();
        await shot(gb, `${lang}-${theme}-${w}-llamacpp`);
        await page.keyboard.press('Escape');
        await expect(dialog).toBeHidden();
      }
      // The Benchmark's expert mode on a saved program: only its own settings.
      const dialog = await addProgram(
        page,
        en ? 'My server' : 'Il mio server',
        en ? { add: 'Add engine', dialog: 'Add an engine', kind: /Program with an OpenAI API/, next: 'Next', name: 'Name' } : undefined,
      );
      await dialog.getByLabel(en ? 'Command that starts the server' : 'Comando che avvia il server').fill(`${SERVER} --max-num-seqs {parallel}`);
      await dialog.getByRole('button', { name: en ? 'Next' : 'Avanti' }).click();
      await dialog.getByRole('button', { name: en ? 'Save engine' : 'Salva motore' }).click();
      await expect(dialog).toBeHidden();
      await page
        .getByRole('region', { name: en ? 'My server' : 'Il mio server' })
        .getByRole('button', { name: en ? 'Use in Benchmark' : 'Usa nel Benchmark' })
        .click();
      await page.getByRole('switch', { name: en ? 'Expert mode' : 'Modalità esperto' }).click();
      await page.getByRole('group', { name: en ? 'Settings of My server' : 'Impostazioni di Il mio server' }).scrollIntoViewIfNeeded();
      await shot(gb, `${lang}-${theme}-1600-benchmark`);
    } finally {
      await gb.close();
    }
  }
});
