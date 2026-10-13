// Renders the key screens to .qa/mockups/*.png (light + dark), with real data.
//
//   node scripts/mockups.mjs              build, then screenshot everything
//   node scripts/mockups.mjs --no-build   reuse the current out/ folder
//   node scripts/mockups.mjs --only=result,run
//
// How it works: the core starts in browser mode (`node out/core/index.cjs`) with a throw-away
// GPUBENCH_DATA_DIR inside the same fake world the E2E tests use (fake nvidia-smi RTX 5090, fake
// GitHub serving llama.cpp whose llama-server is the fake engine, fake Hugging Face, fake Docker),
// so the real settings, models and GPU are never touched. The results folder is seeded with the
// realistic runs of test/fixtures/runs; the live screen shows a real (fake-engine) run started
// through the API. Theme, language, onboarding and expert mode are set with PUT /api/settings
// before each navigation: the same path the UI uses, no special dev hooks. Chromium runs with
// reduced motion so charts render without animation and frames are stable. The "Trova le
// impostazioni migliori" scenes (--only=tune-run,tune-result) run a real search on the fake engine.
import { chromium } from '@playwright/test';
import { execFileSync, spawn } from 'node:child_process';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { startFakeDockerApi } from '../test/fakes/fake-docker/api.mjs';
import { startFakeGithub } from '../test/fakes/fake-github/server.mjs';
import { demoRepos, formatRepos, startFakeHub } from '../test/fakes/fake-hub/hub.mjs';
import { buildGguf, buildSafetensors, llamaLikeGguf } from '../test/fakes/fake-hub/model-files.mjs';
import { SPILL_PROFILE, TUNE_PROFILE } from '../test/fakes/fake-engine/profiles.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = new Set(process.argv.slice(2));
const only = [...args].find((a) => a.startsWith('--only='))?.slice(7).split(',');
const outDir = path.join(root, '.qa', 'mockups');

// Seeded runs (test/fixtures/runs).
const RESULT_ID = '01K6Y7Q2ZC4M8N3B5V9R1T0XWE';
const COMPARE_A = '01K6TZ5G1H4J7K2L8Z3X6C9VBN';
const FAILED_ID = '01K6NA2S5D8F1G4H7J3K6L9ZXC';
// Long conversations before and after a configuration change (written by fakeWorld from COMPARE_A).
const TEAM_BEFORE = '01K6Z0PR1MA00000000000000A';
const TEAM_NOW = '01K6Z1N0W0000000000000000B';
// The seeded Rapido the spill runs are made from, and the two runs of the 0.3.0 report (spillRuns).
const QUICK_ID = '01K6TX9Q2W5E8R1T4Y7U3I6OPA';
const SPILL_CLEAN_ID = '01K6WB0C1EAN000000000000AA';
const SPILL_ID = '01K6WC5P5Q00000000000000AB';

const curated = JSON.parse(readFileSync(path.join(root, 'resources', 'curated-models.json'), 'utf8'));
/** The curated reference model, served by the fake Hugging Face (not on the PC: it is previewed before its download). */
const REFERENCE = curated.reference;
const REFERENCE_PAGE = `/models/hub/${REFERENCE.repo}`;

/**
 * Picks the suggested reference model (not downloaded yet) and opens the command preview: the
 * whole plan is there before anything is installed or downloaded.
 */
async function previewSuggestion(page) {
  await page.getByRole('button', { name: /^Cambia modello:/ }).click();
  const picker = page.getByRole('dialog', { name: 'Scegli un modello' });
  await picker.getByRole('radio', { name: /^Qwen3 4B Q4_K_M/ }).click();
  await picker.getByRole('button', { name: 'Conferma' }).click();
  await page.getByText('· verrà scaricato prima del test').waitFor({ timeout: 30000 });
  await page.getByRole('button', { name: /Anteprima comando/ }).click();
  await page.getByText('Il modello non è ancora sul PC', { exact: false }).waitFor({ timeout: 30000 });
}

/** "Avvia solo il server" on the Benchmark page: the confirmation with the context chosen for this card and the command. */
async function openServeConfirm(page) {
  await page.getByRole('button', { name: 'Avvia solo il server', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Avvia il server' });
  await dialog.getByText(/^[\d.]+ token$/).waitFor({ timeout: 30000 });
}

/** The server started from that confirmation, ready: its address for other programs. */
async function openServeReady(page) {
  await openServeConfirm(page);
  await page.getByRole('button', { name: 'Avvia server' }).click();
  await page.getByRole('dialog', { name: 'Il server è pronto' }).getByText('Indirizzo compatibile OpenAI').waitFor({ timeout: 90000 });
}

/** Picks "Trova le impostazioni migliori" on the Benchmark page. */
async function chooseTune(page) {
  await page.getByRole('radio', { name: /Trova le impostazioni migliori/ }).click();
  await page.getByText('Le impostazioni che contano di più, poche prove.').waitFor({ timeout: 10000 });
}

/** The fake nvidia-smi state of this world (fakeWorld sets it): the busy-GPU scenes change it. */
let smiStateFile = '';
const IDLE_GPU = { gpus: [{ memUsedMiB: 1600, powerW: 38, utilPct: 1, tempC: 39 }] };
/** A VM or a game holds 22 GB of the 32 GB card. */
const BUSY_GPU = { gpus: [{ memUsedMiB: 22_000, powerW: 60, utilPct: 3, tempC: 44 }] };

/** Other programs take most of the card; the plan says so (the verdict stays on the card's total). */
async function busyBenchmark(page) {
  writeFileSync(smiStateFile, JSON.stringify(BUSY_GPU));
  await page.reload();
  await page.getByText('Ora altri programmi usano').first().waitFor({ timeout: 30000 });
}

/** The same busy card from the catalog: one small banner on top. */
async function busyCatalog(page) {
  writeFileSync(smiStateFile, JSON.stringify(BUSY_GPU));
  await page.reload();
  await page.getByText('Ora altri programmi usano').first().waitFor({ timeout: 30000 });
}

function idleGpu() {
  writeFileSync(smiStateFile, JSON.stringify(IDLE_GPU));
}

/** Stops every server a scene started (the next screens, the live run above all, need a free GPU). */
async function stopServers(info) {
  for (const s of await api(info, 'GET', '/api/servers')) await api(info, 'DELETE', `/api/servers/${encodeURIComponent(s.id)}`);
}

/** Risultati → Configurazioni: the tests behind the configuration measured twice. */
async function openConfigTests(page) {
  await page.getByRole('button', { name: /^Mostra i 2 test/ }).click();
  await page.getByRole('dialog', { name: 'Test di questa configurazione' }).waitFor({ timeout: 30000 });
}

/** "Usa questo preset" on the fastest configuration: the Benchmark page with its banner and the exact command. */
async function presetFromConfigs(page) {
  await page.getByRole('button', { name: 'Usa questo preset' }).first().click();
  await page.getByRole('region', { name: 'Preset' }).waitFor({ timeout: 30000 });
  await page.getByText('Pronto a misurare').first().waitFor({ timeout: 30000 });
}

/**
 * More tests of Qwen3 8B (the seeded Full run) so Configurazioni has settings to compare: the same
 * configuration once more, then a q8_0 and a q4_0 KV cache with longer contexts.
 */
function configRuns(base) {
  const head = base.launch.argv.slice(0, base.launch.argv.indexOf('-c'));
  const variant = (id, createdAt, args, params, k) => {
    const run = structuredClone(base);
    Object.assign(run, { id, createdAt, finishedAt: createdAt });
    run.launch.argv = [...head, ...args, '--fit', 'off', '--no-webui'];
    run.launch.params = { ...params, extraArgs: [], env: {} };
    const scale = (s, by) => ({ ...s, median: s.median * by, mean: s.mean * by, values: s.values.map((v) => v * by) });
    run.metrics.latency = run.metrics.latency.map((p) => ({ ...p, decodeTps: scale(p.decodeTps, k), prefillTps: scale(p.prefillTps, 2 - k), ttftMs: scale(p.ttftMs, k) }));
    return run;
  };
  return [
    variant('01K6ZA2B3C4D5E6F7G8H9J0KMN', '2026-10-06T18:20:00.000Z', ['-c', '8192', '-ngl', 'all', '-fa', 'on', '-ub', '512', '-b', '2048'], { contextSize: 8192, flashAttention: 'on' }, 1.02),
    variant('01K6ZB2B3C4D5E6F7G8H9J0KMN', '2026-10-07T08:10:00.000Z', ['-c', '32768', '-ngl', 'all', '-fa', 'on', '-ctk', 'q8_0', '-ctv', 'q8_0', '-ub', '1024'], { contextSize: 32768, flashAttention: 'on', kvCacheType: 'q8_0', ubatchSize: 1024 }, 1.06),
    variant('01K6ZC2B3C4D5E6F7G8H9J0KMN', '2026-10-07T08:40:00.000Z', ['-c', '65536', '-ngl', 'all', '-fa', 'on', '-ctk', 'q4_0', '-ctv', 'q4_0', '-ub', '2048', '-b', '4096'], { contextSize: 65536, flashAttention: 'on', kvCacheType: 'q4_0', ubatchSize: 2048, batchSize: 4096 }, 0.97),
  ];
}

/** This PC's id as the core computes it (core/sysinfo/fingerprint.ts), for the seeded runs made "here". */
function thisHostId() {
  let machineId;
  try {
    if (process.platform === 'win32') {
      const out = execFileSync('reg', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'], { encoding: 'utf8', windowsHide: true });
      machineId = /MachineGuid\s+REG_\w+\s+(\S+)/i.exec(out)?.[1];
    } else machineId = readFileSync('/etc/machine-id', 'utf8').trim() || undefined;
  } catch {
    // The core falls back to the host name too.
  }
  return createHash('sha256').update(`gpu-bench:${(machineId ?? os.hostname()).trim().toLowerCase()}`).digest('hex');
}

/**
 * n, name, route, settings patch, optional page action (`click`, `keys`, or `act` for several steps;
 * after `act` the page is reloaded so the next screens start clean; `after(info)` undoes what it
 * started in the core), and which sizes to render.
 */
/** The fake engine stands in for every custom engine (GPUBENCH_LLAMA_LAUNCHER runs it with node). */
const FAKE_ENGINE_CLI = path.join(root, 'test', 'fakes', 'fake-engine', 'cli.mjs');
const CUSTOM_ENGINES = [
  {
    id: 'prismml',
    name: 'PrismML',
    base: 'llamacpp',
    run: { mode: 'native', path: FAKE_ENGINE_CLI },
    extraArgs: ['--ternary-kernels', 'on'],
    // The fake engine's fork mode: its own --version, no -ub.
    env: { FAKE_ENGINE_HELP: 'fork' },
    notes: 'Compilato da github.com/PrismML con CUDA 13.',
    match: { names: ['bonsai'], quants: ['PQ2_0', 'PTQ1_0'] },
    template: 'prismml-bonsai',
  },
  { id: 'sglang-team', name: 'SGLang del team', base: 'sglang', run: { mode: 'docker', image: 'ghcr.io/team/sglang:v0.5.21-fp4' }, extraArgs: [], env: {}, notes: '' },
  {
    id: 'my-server',
    name: 'Il mio server',
    base: 'openai-server',
    run: { mode: 'command', template: `"${process.execPath}" "${FAKE_ENGINE_CLI}" serve {model} --port {port} --served-model-name {alias}`, api: 'completions' },
    extraArgs: [],
    env: {},
    notes: '',
  },
];

const SCREENS = [
  { n: 1, name: 'welcome', route: '/welcome', wait: 'Controllo del sistema' },
  { n: 2, name: 'benchmark', route: '/', wait: 'Pronto a misurare', small: true },
  // Before the live run below installs llama.cpp: engine and model are both still to fetch.
  { n: 15, name: 'benchmark-download', route: '/', wait: 'Pronto a misurare', act: previewSuggestion, small: true, full: true },
  // Before the live run below installs llama.cpp: the server confirmation lists its install too.
  { n: 17, name: 'serve-confirm', route: '/', wait: 'Pronto a misurare', act: openServeConfirm, small: true },
  { n: 3, name: 'run', route: 'LIVE', wait: 'Test in corso', settle: 2500 },
  { n: 4, name: 'result', route: `/results/${RESULT_ID}`, wait: 'Punteggio GPU Bench', small: true },
  { n: 5, name: 'benchmark-expert', route: '/', wait: 'Pronto a misurare', settings: { expertMode: true }, full: true },
  { n: 6, name: 'result-launch', route: `/results/${RESULT_ID}`, wait: 'Punteggio GPU Bench', tab: 'Come è stato avviato' },
  { n: 7, name: 'model-picker', route: '/', wait: 'Pronto a misurare', click: { role: 'button', name: /Cambia modello/ } },
  { n: 8, name: 'results', route: '/results', wait: 'Risultati' },
  { n: 9, name: 'monitor', route: '/monitor', wait: 'Monitor GPU', settle: 900 },
  { n: 10, name: 'settings', route: '/settings', wait: 'Impostazioni' },
  { n: 11, name: 'palette', route: '/', wait: 'Avvia benchmark', keys: 'Control+K' },
  { n: 12, name: 'result-en', route: `/results/${RESULT_ID}`, wait: 'GPU Bench score', settings: { language: 'en' } },
  { n: 13, name: 'compare', route: `/compare?a=${COMPARE_A}&b=${RESULT_ID}`, wait: 'Cosa cambia tra i due' },
  { n: 14, name: 'result-failed', route: `/results/${FAILED_ID}`, wait: 'Cosa fare' },
  { n: 16, name: 'model', route: REFERENCE_PAGE, wait: 'Scegli la versione da scaricare', settle: 1500 },
  { n: 18, name: 'models-local', route: '/models', wait: 'Fai il benchmark' },
  { n: 19, name: 'serve-ready', route: '/', wait: 'Pronto a misurare', act: openServeReady, after: stopServers },
  { n: 20, name: 'results-configs', route: '/results?view=configs', wait: 'Confronta a', settle: 1500, small: true },
  { n: 21, name: 'configs-tests', route: '/results?view=configs', wait: 'Confronta a', act: openConfigTests },
  { n: 22, name: 'benchmark-preset', route: '/results?view=configs', wait: 'Confronta a', act: presetFromConfigs, full: true },
  { n: 23, name: 'long-conversations', route: `/results/${TEAM_NOW}`, wait: 'Conversazioni lunghe', act: showLongConversations, small: true, full: true },
  { n: 24, name: 'compare-words', route: `/compare?a=${TEAM_BEFORE}&b=${TEAM_NOW}`, wait: 'Cosa cambia tra i due', full: true },
  { n: 25, name: 'sheet-dialog', route: `/compare?a=${TEAM_BEFORE}&b=${TEAM_NOW}`, wait: 'Cosa cambia tra i due', act: openSheetDialog },
  { n: 26, name: 'sheet-html', route: `/compare?a=${TEAM_BEFORE}&b=${TEAM_NOW}`, wait: 'Cosa cambia tra i due', act: openSheetHtml, full: true },
  // The "Trova le impostazioni migliori" choice with its options (the run and the result: tuneScenes, 28 and 29).
  { n: 27, name: 'benchmark-tune', route: '/', wait: 'Pronto a misurare', act: chooseTune, small: true, full: true },
  // A run that spilled into shared memory (the real numbers of the 0.3.0 report). Live: spillScenes, 31-33.
  { n: 30, name: 'result-spill', route: `/results/${SPILL_ID}`, wait: 'Il modello non è entrato tutto nella memoria della scheda', small: true, full: true },
  // Formats: each repo's formats as badges with their engine, a mixed repo split by format, the library grouped.
  { n: 34, name: 'catalog-formats', route: '/models?tab=download&engine=any', wait: 'Di tendenza su Hugging Face', settle: 1500, small: true },
  { n: 35, name: 'model-formats', route: '/models/hub/nerkyor/Qwen3.8-27B-Coder390-GGUF-NInfer', wait: 'Per vLLM / SGLang (safetensors)', settle: 2000, small: true, full: true },
  { n: 36, name: 'models-local-formats', route: '/models', wait: 'Per vLLM / SGLang (safetensors)', settle: 1500, small: true, full: true },
  { n: 37, name: 'model-ninfer', route: '/models/hub/neroued/Qwen3.8-27B-nvfp4-NInfer', wait: 'Per NInfer (ottimizzato per RTX 5090)', settle: 1500 },
  // The card is busy with other programs: a calm note before the test, one banner on the catalog.
  { n: 38, name: 'busy-note', route: '/', wait: 'Pronto a misurare', act: busyBenchmark, after: idleGpu, small: true, full: true },
  { n: 39, name: 'catalog-busy', route: '/models?tab=download', wait: 'Di tendenza su Hugging Face', act: busyCatalog, after: idleGpu },
  // "Motori personalizzati" and SGLang on the Engines page: a llama.cpp fork that lacks -ub, an SGLang fork image
  // not pulled yet, a program with an OpenAI API.
  { n: 40, name: 'engines-custom', route: '/engines', wait: 'Motori personalizzati', settings: { customEngines: CUSTOM_ENGINES }, act: showCustomEngines, small: true, full: true },
  // "Aggiungi motore": a llama.cpp fork, its "Prova" (version, the flag it lacks).
  { n: 41, name: 'engines-add', route: '/engines', wait: 'Motori personalizzati', settings: { customEngines: [] }, act: addForkDialog, small: true },
  // The Bonsai suggestion: a Bonsai model chosen, no fork indicated yet.
  { n: 42, name: 'benchmark-bonsai', route: '/', wait: 'Pronto a misurare', settings: { customEngines: [] }, act: chooseBonsai, small: true },
  // The deep link of that suggestion: "Aggiungi motore" filled from the PrismML template.
  { n: 43, name: 'engines-template', route: `/engines?customTemplate=prismml-bonsai&modelName=${encodeURIComponent('Ternary-Bonsai-8B PQ2_0')}`, wait: 'Serve per Ternary-Bonsai-8B PQ2_0', settings: { customEngines: [] }, small: true },
  // The engine choice with the custom engines under their base.
  { n: 44, name: 'benchmark-engines', route: '/', wait: 'Pronto a misurare', settings: { customEngines: CUSTOM_ENGINES }, act: openEngineChoice },
];

/** The custom engines section, scrolled into view once every check has answered. */
async function showCustomEngines(page) {
  const section = page.getByRole('region', { name: 'Motori personalizzati' }).or(page.locator('section[aria-labelledby="custom-engines-title"]'));
  await section.first().scrollIntoViewIfNeeded();
  await page.getByText('Questo motore non conosce alcune impostazioni di GPU Bench').first().waitFor({ timeout: 30000 });
}

/** "Aggiungi motore" → fork of llama.cpp → where it is → "Prova". */
async function addForkDialog(page) {
  await page.getByRole('button', { name: 'Aggiungi motore' }).click();
  const dialog = page.getByRole('dialog', { name: 'Aggiungi un motore' });
  await dialog.getByRole('radio', { name: /Fork di llama\.cpp/ }).click();
  await dialog.getByRole('button', { name: 'Avanti' }).click();
  await dialog.getByLabel('Nome').fill('PrismML');
  await dialog.getByLabel('Il programma llama-server').fill(FAKE_ENGINE_CLI);
  // The dialog cannot set the probe environment before "Opzioni": the fake answers as a plain build here.
  await dialog.getByRole('button', { name: 'Prova' }).click();
  await dialog.getByText(/Funziona/).first().waitFor({ timeout: 30000 });
}

/** A Bonsai model on the Benchmark page: the suggestion of the PrismML fork. */
async function chooseBonsai(page) {
  await chooseModel(page, /Bonsai/);
  await page.getByText('Questo modello richiede il fork PrismML di llama.cpp').waitFor({ timeout: 30000 });
  await page.getByRole('button', { name: 'Scopri di più' }).click();
}

/** The engine choice opened: custom engines under the engine they are built on. */
async function openEngineChoice(page) {
  await page.getByRole('combobox', { name: 'Cambia motore' }).click();
  await page.getByRole('option', { name: /PrismML/ }).waitFor({ timeout: 10000 });
}

/** Slow enough that the live screen is mid-run when it is photographed. */
const LIVE_PROFILE = { loadMsCold: 2600, loadMsWarm: 900, prefillTps: 8900, decodeTps: 46, tokensPerChunk: 1 };
/**
 * "Trova le impostazioni migliori" (test/fakes/fake-engine/profiles.mjs): q4_0 holds the largest context,
 * a larger micro-batch reads faster, f16 runs out of memory early. Loads slowed down so the live
 * screen is photographed mid-search.
 */
const TUNE_SHOT_PROFILE = { ...TUNE_PROFILE, loadMsCold: 1800, loadMsWarm: 1500, decodeTps: 600 };
/** Sizes of the tune scenes. */
const TUNE_SIZES = [
  { w: 1600, h: 1000, suffix: '' },
  { w: 1024, h: 700, suffix: '-1024' },
];

/** The "Conversazioni lunghe" section of a result, scrolled into view. */
async function showLongConversations(page) {
  await page.getByRole('region', { name: 'Conversazioni lunghe', exact: true }).scrollIntoViewIfNeeded();
}

/** "Scheda da condividere" from the Compare page, with the optional fields filled in. */
async function openSheetDialog(page) {
  await page.getByRole('button', { name: 'Scheda da condividere' }).click();
  const dialog = page.getByRole('dialog', { name: 'Scheda da condividere' });
  await dialog.getByLabel('Nome del servizio').fill('Assistente del team');
  await dialog.getByLabel('Indirizzo').fill('http://server-gpu:8000/v1');
  await dialog.getByLabel('Note').fill('Riavvio automatico ogni lunedì alle 6. Per problemi scrivere a #team-ai.');
}

/** The exported HTML sheet itself (browser mode saves it as a download), opened as a page. */
async function openSheetHtml(page) {
  await openSheetDialog(page);
  await page.getByRole('dialog').getByRole('radio', { name: /Pagina HTML/ }).click();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Salva la scheda' }).click();
  const file = path.join(os.tmpdir(), `gpubench-mockup-sheet-${process.pid}.html`);
  await (await download).saveAs(file);
  await page.goto(pathToFileURL(file).href);
  await page.getByText('Il contesto si legge una volta sola').first().waitFor({ timeout: 10000 });
}

/** A Stat over measured values (as the core stores it). */
function stat(values) {
  const n = values.length;
  const sorted = [...values].sort((a, b) => a - b);
  const mean = values.reduce((x, y) => x + y, 0) / n;
  const median = n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
  const stddev = n > 1 ? Math.sqrt(values.reduce((x, y) => x + (y - mean) ** 2, 0) / (n - 1)) : 0;
  return { n, median, mean, min: sorted[0], max: sorted[n - 1], stddev, cv: mean ? stddev / mean : 0, values };
}

/** One level of long conversations at 200 000 tokens (the numbers of the team page the user shared). */
function level(sessions, o) {
  return {
    sessions,
    depth: 200000,
    turns: 3,
    outputTokens: 256,
    followupTokens: 256,
    firstTurn: { ttftMs: stat(o.first), prefillTps: stat(o.prefill), queueWaitMs: stat(o.queue), decodeTps: stat(o.decode) },
    laterTurns: { ttftMs: stat(o.later), cachedShare: stat(o.share), decodeTps: stat(o.decode) },
    aggregatePrefillTps: o.read,
    queueEstimated: true,
    requests: sessions * 3,
    errors: 0,
  };
}

/** Two vLLM runs with long conversations, before and after a configuration change. */
function teamRuns(base) {
  const before = structuredClone(base);
  Object.assign(before, { id: TEAM_BEFORE, createdAt: '2026-10-06T08:00:00.000Z', finishedAt: '2026-10-06T08:20:00.000Z' });
  before.metrics.sessions = [level(1, { first: [247000], prefill: [795], queue: [0], decode: [27.4], later: [246000, 246500], share: [0, 0], read: 795 })];
  before.metrics.kvCapacity = { tokens: 399806, maxConcurrencyAtTokens: { tokens: 200000, concurrency: 1.99 } };
  const now = structuredClone(base);
  Object.assign(now, { id: TEAM_NOW, createdAt: '2026-10-07T08:00:00.000Z', finishedAt: '2026-10-07T08:22:00.000Z' });
  now.metrics.sessions = [
    level(1, { first: [113000], prefill: [1763], queue: [0], decode: [31.7], later: [1000, 1000], share: [0.997, 0.997], read: 1763 }),
    level(2, { first: [112000, 222000], prefill: [1785, 1780], queue: [0, 108000], decode: [18.4, 18.4], later: [5400, 5400, 5400, 5400], share: [0.975, 0.975, 0.975, 0.975], read: 1332 }),
  ];
  now.metrics.kvCapacity = { tokens: 889820, maxConcurrencyAtTokens: { tokens: 200000, concurrency: 4.45 } };
  return [before, now];
}

/**
 * The 0.3.0 report on an RTX 5090 (a 27B Q4 of 17.6 GB), from the seeded Rapido of Mistral Small: a
 * clean Rapido (53.7 tok/s), then the same with -c 262144 — it loaded, Windows put 4 666 MiB in shared
 * memory and generation fell to 3.5 tok/s, with no error anywhere.
 */
function spillRuns(base, modelPath) {
  const oldPath = base.model.path;
  const oldFile = base.model.file;
  const swap = (o) => JSON.parse(JSON.stringify(o), (_k, v) => (typeof v === 'string' ? v.replaceAll(oldPath, modelPath).replaceAll(oldFile, 'Qwen3-27B-Q4_K_M.gguf') : v));
  const model = {
    ...base.model,
    displayName: 'Qwen3 27B',
    file: 'Qwen3-27B-Q4_K_M.gguf',
    files: ['Qwen3-27B-Q4_K_M.gguf'],
    sizeBytes: 17_600_000_000,
    weakKey: 'local/Qwen3-27B-Q4_K_M.gguf/Q4_K_M/17600000000',
    path: modelPath,
    facts: { ...base.model.facts, paramsB: 27, contextLength: 262_144, blockCount: 64 },
  };
  const point = (prefill, decode) => {
    const ttft = prefill.map((p) => (512 / p) * 1000);
    const itl = 1000 / decode[1];
    return {
      promptTokens: 512,
      outputTokens: 128,
      ttftMs: stat(ttft),
      prefillTps: stat(prefill),
      prefillTpsEngine: stat(prefill.map((p) => p * 1.01)),
      decodeTps: stat(decode),
      decodeTpsEngine: stat(decode.map((d) => d * 0.99)),
      itlP50Ms: itl,
      itlP95Ms: itl * 1.05,
      itlPerChunk: false,
      totalMs: stat(ttft.map((t, i) => t + (128 / decode[i]) * 1000)),
    };
  };
  const memory = (peak) => base.telemetry.memUsedMiB.map((v) => Math.round(1638 + ((v - 3992) * (peak - 1638)) / 15700));
  const clean = swap(base);
  Object.assign(clean, { id: SPILL_CLEAN_ID, createdAt: '2026-10-05T09:10:00.000Z', finishedAt: '2026-10-05T09:11:48.000Z', model });
  clean.metrics.load.warmMs = stat([6120]);
  clean.metrics.latency = [point([1802, 1810, 1795], [53.7, 53.8, 53.6])];
  clean.metrics.vram = { baselineMiB: 1638, peakMiB: 19_850, deltaMiB: 18_212, estimateMiB: 19_420, method: 'total-delta' };
  clean.telemetry.memUsedMiB = memory(19_850);

  const spilled = swap(base);
  const ctx = (s) => s.replace(/-c 1024/g, '-c 262144');
  Object.assign(spilled, { id: SPILL_ID, createdAt: '2026-10-05T09:16:00.000Z', finishedAt: '2026-10-05T09:19:32.000Z', model });
  spilled.launch.argv = spilled.launch.argv.map((a, i, all) => (all[i - 1] === '-c' ? '262144' : a));
  spilled.launch.display = { powershell: ctx(spilled.launch.display.powershell), bash: ctx(spilled.launch.display.bash) };
  spilled.launch.params = { ...spilled.launch.params, contextSize: 262_144 };
  spilled.metrics.load.warmMs = stat([11_480]);
  spilled.metrics.latency = [point([548, 541, 556], [3.5, 3.4, 3.6])];
  spilled.metrics.vram = { baselineMiB: 1638, peakMiB: 32_410, deltaMiB: 30_772, estimateMiB: 35_900, method: 'total-delta', sharedPeakMiB: 4666 };
  spilled.metrics.spill = {
    by: ['shared-memory', 'decode-collapse'],
    sharedPeakMiB: 4666,
    thresholdMiB: 1024,
    decodeTps: 3.5,
    normalDecodeTps: 53.7,
    normalRunIds: [SPILL_CLEAN_ID],
    fixes: { kvCacheType: 'q4_0', maxContext: 184_320 },
  };
  spilled.validity = ['shared_memory_spill'];
  spilled.telemetry = { ...spilled.telemetry, t: spilled.telemetry.t.map((t) => t * 2), memUsedMiB: memory(32_410), marks: spilled.telemetry.marks.map((m) => ({ ...m, t: m.t * 2 })) };
  spilled.logExcerpt = spilled.logExcerpt.replaceAll('n_ctx         = 8192', 'n_ctx         = 262144').replaceAll('n_ctx_slot = 8192', 'n_ctx_slot = 262144');
  return [clean, spilled];
}

/** Fake world (see test/e2e/global-setup.ts) and a data folder with models, runs and settings. */
async function fakeWorld(dataDir) {
  const cli = path.join(root, 'test', 'fakes', 'fake-engine', 'cli.mjs');
  const github = await startFakeGithub({ serverBinaryData: `import(${JSON.stringify(pathToFileURL(cli).href)});\n` });
  const hub = await startFakeHub({
    repos: [
      ...demoRepos(),
      ...formatRepos(),
      {
        id: REFERENCE.repo,
        sha: REFERENCE.revision,
        downloads: 812_000,
        likes: 540,
        license: 'apache-2.0',
        lastModified: '2026-09-12T10:00:00.000Z',
        pipelineTag: 'text-generation',
        baseModel: 'Qwen/Qwen3-4B',
        tags: ['gguf', 'text-generation'],
        readme: '---\nlicense: apache-2.0\n---\n# Qwen3-4B-GGUF\n\nQwen3 4B quantized for llama.cpp. The **reference** model of the GPU Bench score.\n',
        files: [{ path: REFERENCE.file, gguf: { ...llamaLikeGguf({ name: 'Qwen3 4B', sizeLabel: '4B' }), totalSize: 192 * 1024 } }],
      },
    ],
  });
  const dockerApi = await startFakeDockerApi({ images: {} });
  // Docker Hub tags (vLLM and SGLang cards): recorded listings, never the real site.
  const tagFixture = (name) => readFileSync(path.join(root, 'test', 'fixtures', 'docker', name));
  const dockerHub = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(tagFixture((req.url ?? '').includes('lmsysorg') ? 'hub-tags-sglang.json' : 'hub-tags-vllm.json'));
  });
  await new Promise((resolve) => dockerHub.listen(0, '127.0.0.1', resolve));
  const models = path.join(dataDir, 'models', 'local');
  mkdirSync(models, { recursive: true });
  writeFileSync(path.join(models, 'Qwen3-8B-Q4_K_M.gguf'), buildGguf({ ...llamaLikeGguf({ name: 'Qwen3 8B', sizeLabel: '8B' }), totalSize: 96 * 1024 }));
  writeFileSync(path.join(models, 'gemma-4-12b-it-Q4_K_M.gguf'), buildGguf({ ...llamaLikeGguf({ name: 'Gemma 4 12B', sizeLabel: '12B' }), totalSize: 128 * 1024 }));
  // 64 layers × 8 KV heads × 128: 256 MiB of KV per 1K tokens, 64 GB at its 256K (the spill scenes).
  writeFileSync(path.join(models, 'Qwen3-27B-Q4_K_M.gguf'), buildGguf({ ...llamaLikeGguf({ name: 'Qwen3 27B', sizeLabel: '27B', layers: 64, ctx: 262_144 }), totalSize: 160 * 1024 }));
  // Every format in the library: a safetensors model for vLLM / SGLang, a download stopped at 1 of 4
  // files, an NInfer artifact with its manifest (the Bonsai quant below shows the fork badge). In a
  // folder added by the user (after the library: the Benchmark page keeps its usual first model), each repo
  // folder with GPU Bench's download sidecar, as when another install's library is added.
  const lib = path.join(dataDir, 'more-models');
  const sidecar = (dir, repo) => writeFileSync(path.join(dir, '.gpubench-download.json'), JSON.stringify({ repo, files: {} }));
  const st = path.join(lib, 'Qwen', 'Qwen3-8B-FP8');
  mkdirSync(st, { recursive: true });
  writeFileSync(path.join(st, 'config.json'), JSON.stringify({ architectures: ['Qwen3ForCausalLM'], num_hidden_layers: 36, num_attention_heads: 32, num_key_value_heads: 8, head_dim: 128, quantization_config: { quant_method: 'fp8' } }));
  writeFileSync(path.join(st, 'model.safetensors'), buildSafetensors({ tensors: { w: { dtype: 'F8_E4M3', shape: [64, 64] } }, totalSize: 128 * 1024 }));
  sidecar(st, 'Qwen/Qwen3-8B-FP8');
  const orca = path.join(lib, 'orcarouter', 'OrcaSAQ-2-27B');
  mkdirSync(orca, { recursive: true });
  writeFileSync(path.join(orca, 'config.json'), JSON.stringify({ num_hidden_layers: 64, torch_dtype: 'bfloat16' }));
  writeFileSync(path.join(orca, 'model-00001-of-00004.safetensors'), buildSafetensors({ tensors: { w: { dtype: 'BF16', shape: [64, 64] } }, totalSize: 160 * 1024 }));
  sidecar(orca, 'orcarouter/OrcaSAQ-2-27B');
  const ninfer = path.join(lib, 'neroued', 'Qwen3.8-27B-nvfp4-NInfer');
  mkdirSync(ninfer, { recursive: true });
  writeFileSync(path.join(ninfer, 'qwen3_8_27b_nvfp4.ninfer'), Buffer.alloc(192 * 1024, 1));
  sidecar(ninfer, 'neroued/Qwen3.8-27B-nvfp4-NInfer');
  writeFileSync(path.join(ninfer, 'Qwen3.8-27B-nvfp4-NInfer.artifact-manifest.json'), JSON.stringify({ artifact: { name: 'qwen3.8-27b', architecture: 'qwen3_8', container_version: 3, components: ['text', 'vision', 'mtp'] } }));
  // A PrismML Bonsai model (ternary weights: only the PrismML fork of llama.cpp reads them).
  writeFileSync(path.join(models, 'Ternary-Bonsai-8B-PQ2_0.gguf'), buildGguf({ ...llamaLikeGguf({ name: 'Ternary Bonsai 8B', sizeLabel: '8B' }), totalSize: 64 * 1024 }));
  const results = path.join(dataDir, 'results');
  mkdirSync(results, { recursive: true });
  const seeds = path.join(root, 'test', 'fixtures', 'runs');
  const hostId = thisHostId();
  for (const f of readdirSync(seeds).filter((x) => x.endsWith('.json'))) {
    writeFileSync(path.join(results, f), readFileSync(path.join(seeds, f), 'utf8').replaceAll('__THIS_HOST_ID__', hostId).replaceAll('__THIS_PC__', os.hostname()));
  }
  // The Qwen3 8B tests point at the library copy of this fake world, so their presets find the model.
  const fullFile = path.join(results, readdirSync(results).find((f) => f.includes(RESULT_ID)));
  const full = JSON.parse(readFileSync(fullFile, 'utf8'));
  full.model.path = path.join(models, 'Qwen3-8B-Q4_K_M.gguf');
  writeFileSync(fullFile, JSON.stringify(full));
  for (const run of configRuns(full)) writeFileSync(path.join(results, `${run.id}.json`), JSON.stringify(run));
  const base = JSON.parse(readFileSync(path.join(results, readdirSync(results).find((f) => f.includes(COMPARE_A))), 'utf8'));
  for (const run of teamRuns(base)) writeFileSync(path.join(results, `${run.createdAt.slice(0, 10)}_08-00-00_${run.id}.json`), JSON.stringify(run, null, 2));
  const quick = JSON.parse(readFileSync(path.join(results, readdirSync(results).find((f) => f.includes(QUICK_ID))), 'utf8'));
  for (const run of spillRuns(quick, path.join(models, 'Qwen3-27B-Q4_K_M.gguf'))) writeFileSync(path.join(results, `${run.id}.json`), JSON.stringify(run, null, 2));
  writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify({ scanKnownLocations: false, onboardingDone: true, extraModelDirs: [lib] }));
  const profileFile = path.join(dataDir, 'fake-engine-profile.json');
  writeFileSync(profileFile, JSON.stringify(LIVE_PROFILE));
  const smiState = path.join(dataDir, 'fake-nvidia-smi.json');
  smiStateFile = smiState;
  writeFileSync(smiState, JSON.stringify(IDLE_GPU));
  const env = {
    GPUBENCH_GITHUB_API: github.url,
    GPUBENCH_HF_ENDPOINT: hub.url,
    GPUBENCH_DOCKER_HOST: dockerApi.socketPath,
    GPUBENCH_DOCKERHUB: `http://127.0.0.1:${dockerHub.address().port}`,
    GPUBENCH_DOCKER: JSON.stringify([process.execPath, path.join(root, 'test', 'fakes', 'fake-docker', 'fake-docker.mjs')]),
    FAKE_DOCKER_STATE: path.join(dataDir, 'fake-docker'),
    GPUBENCH_NVIDIA_SMI: JSON.stringify([process.execPath, path.join(root, 'test', 'fakes', 'fake-nvidia-smi', 'fake-nvidia-smi.mjs')]),
    FAKE_NVIDIA_SMI_STATE: smiState,
    GPUBENCH_LLAMA_LAUNCHER: JSON.stringify([process.execPath]),
    // A file the fake engine reads at every launch: the tune scenes switch it to the tuner's profile.
    FAKE_ENGINE_PROFILE: profileFile,
    FAKE_ENGINE_ALLOW_MISSING_MODEL: '1',
  };
  return { env, profileFile, close: () => Promise.all([github.close(), hub.close(), dockerApi.close(), new Promise((r) => dockerHub.close(r))]) };
}

function startCore(dataDir, extraEnv) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [path.join(root, 'out/core/index.cjs')], {
      env: { ...process.env, ...extraEnv, GPUBENCH_DATA_DIR: dataDir, GPUBENCH_MODELS_DIR: path.join(dataDir, 'models') },
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    let buf = '';
    proc.stdout.on('data', (d) => {
      buf += d.toString();
      const line = buf.split('\n').find((l) => l.includes('"ready"'));
      if (line) resolve({ proc, info: JSON.parse(line) });
    });
    proc.on('exit', (code) => reject(new Error(`core exited (${code})`)));
  });
}

async function api(info, method, route, body) {
  const res = await fetch(`http://127.0.0.1:${info.port}${route}`, {
    method,
    headers: { authorization: `Bearer ${info.token}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!res.ok) throw new Error(`${method} ${route} → ${res.status} ${await res.text()}`);
  return res.json();
}

const putSettings = (info, patch) => api(info, 'PUT', '/api/settings', patch);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * A run in progress for the live screen, started the way a user does (Standard, Avvia, and the
 * one-time llama.cpp install), photographed once generation is under way.
 */
async function openLiveRun(page, info) {
  const { active } = await api(info, 'GET', '/api/runs/active');
  if (active) await api(info, 'POST', `/api/runs/${active.runId}/cancel`);
  while ((await api(info, 'GET', '/api/runs/active')).active) await sleep(300);
  await page.goto(`${info.url}#/`);
  await page.getByText('Pronto a misurare').first().waitFor({ timeout: 30000 });
  await page.getByRole('radio', { name: /Standard/ }).click();
  await page.getByRole('button', { name: 'Avvia benchmark' }).click();
  const confirm = page.getByRole('button', { name: 'Scarica e avvia' });
  if (await confirm.waitFor({ timeout: 3000 }).then(() => true, () => false)) await confirm.click();
  await page.getByRole('heading', { level: 1, name: 'Test in corso' }).waitFor({ timeout: 60000 });
  for (let i = 0; i < 240; i++) {
    const now = (await api(info, 'GET', '/api/runs/active')).active;
    if (!now || now.progress > 0.35) break;
    await sleep(500);
  }
}

/**
 * "Trova le impostazioni migliori": started like a user does (the profile, Avvia, the llama.cpp install
 * on a first run), the live screen photographed mid-search, then the result. Light and dark, at
 * 1600×1000 and 1024×700.
 */
async function tuneScenes(browser, info, world, written) {
  const want = (name) => !only || only.includes(name);
  if (!want('tune-run') && !want('tune-result')) return;
  writeFileSync(world.profileFile, JSON.stringify(TUNE_SHOT_PROFILE));
  const shots = async (n, name, route, wait) => {
    for (const theme of ['light', 'dark']) {
      for (const size of TUNE_SIZES) {
        await putSettings(info, { theme, language: 'it', density: 'comfortable', expertMode: false, onboardingDone: true });
        const context = await browser.newContext({ viewport: { width: size.w, height: size.h }, deviceScaleFactor: 1, reducedMotion: 'reduce', colorScheme: theme, locale: 'it-IT' });
        const page = await context.newPage();
        await page.goto(`${info.url}#${route}`);
        await page.getByText(wait).first().waitFor({ timeout: 60000 });
        await page.evaluate(() => document.fonts.ready);
        await page.waitForTimeout(2500);
        await page.mouse.move(size.w - 4, size.h - 4);
        const file = path.join(outDir, `${n}-${name}-${theme}${size.suffix}.png`);
        await shoot(page, file);
        written.push(file);
        {
          const fullFile = file.replace(/\.png$/, '-full.png');
          await shoot(page, fullFile, { full: true });
          written.push(fullFile);
        }
        await context.close();
      }
    }
  };
  try {
    const { active } = await api(info, 'GET', '/api/runs/active');
    if (active) await api(info, 'POST', `/api/runs/${active.runId}/cancel`);
    while ((await api(info, 'GET', '/api/runs/active')).active) await sleep(300);
    await putSettings(info, { theme: 'light', language: 'it', expertMode: false, onboardingDone: true });
    const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, reducedMotion: 'reduce', locale: 'it-IT' });
    const page = await context.newPage();
    await page.goto(`${info.url}#/`);
    await page.getByText('Pronto a misurare').first().waitFor({ timeout: 30000 });
    await page.getByRole('radio', { name: /Trova le impostazioni migliori/ }).click();
    await page.getByRole('button', { name: 'Avvia benchmark' }).click();
    const confirm = page.getByRole('button', { name: 'Scarica e avvia' });
    if (await confirm.waitFor({ timeout: 3000 }).then(() => true, () => false)) await confirm.click();
    await page.getByRole('heading', { level: 1, name: 'Test in corso' }).waitFor({ timeout: 60000 });
    await context.close();
    const runId = (await api(info, 'GET', '/api/runs/active')).active.runId;
    // Mid-search: a few launches done, some of them out of memory.
    for (let i = 0; i < 600; i++) {
      const now = (await api(info, 'GET', '/api/runs/active')).active;
      if (!now || (now.tuning?.attempts.length ?? 0) >= 6) break;
      await sleep(500);
    }
    if (want('tune-run')) await shots(28, 'tune-run', `/run/${runId}`, 'Prove fatte');
    while ((await api(info, 'GET', '/api/runs/active')).active) await sleep(1000);
    if (want('tune-result')) await shots(29, 'tune-result', `/results/${runId}`, 'Classifica delle combinazioni');
  } finally {
    writeFileSync(world.profileFile, JSON.stringify(LIVE_PROFILE));
  }
}

/**
 * The RTX 5090 of the 0.3.0 report with a 27B model (fakeWorld's Qwen3-27B: 256 MiB of KV per 1K
 * tokens): 53.7 tok/s on a short prompt; at -c 262144 it loads anyway, spills and generates at 0.065×
 * (3.5 tok/s). Prompt reading and generation slow down with depth like the real card.
 */
const SPILL_SHOT_PROFILE = { ...SPILL_PROFILE, loadMsCold: 2500, loadMsWarm: 1800, prefillTps: 3000, decodeTps: 53.7, tokensPerChunk: 1 };

/**
 * "Trova le impostazioni migliori" that runs out of time (TUNE_PROFILE's memory): generation at 40 tok/s,
 * far below what the search expects for a file this small, so its own limit cuts it after the first
 * screenings.
 */
const TUNE_PARTIAL_PROFILE = { ...TUNE_PROFILE, loadMsCold: 1800, loadMsWarm: 1500, prefillTps: 9000, decodeTps: 40, tokensPerChunk: 1 };

const QWEN_27B = /^Qwen3[ -]27B/;

/** Picks a library model on the Benchmark page. */
async function chooseModel(page, name) {
  await page.getByRole('button', { name: /^Cambia modello:/ }).click();
  const picker = page.getByRole('dialog', { name: 'Scegli un modello' });
  await picker.getByRole('radio', { name }).first().click();
  await picker.getByRole('button', { name: 'Conferma' }).click();
}

async function idle(info) {
  const { active } = await api(info, 'GET', '/api/runs/active');
  if (active) await api(info, 'POST', `/api/runs/${active.runId}/cancel`);
  while ((await api(info, 'GET', '/api/runs/active')).active) await sleep(500);
}

/**
 * A run that spills, as a user meets it on this fake card: a clean Rapido of the 27B first (the usual
 * speed), then the whole 256K context in expert mode — the plan's warning with its fixes (33), started
 * anyway: the live screen's banner once generation collapses (31). Then "Trova le impostazioni migliori"
 * on Qwen3 8B, cut by its own time limit: partly measured combinations (32). Light and dark.
 */
async function spillScenes(browser, info, world, written) {
  const want = (name) => !only || only.includes(name);
  if (!want('spill-live') && !want('benchmark-spill') && !want('tune-partial')) return;
  const shotAll = async (n, name, route, wait, opts = {}) => {
    for (const theme of ['light', 'dark']) {
      for (const size of opts.sizes ?? TUNE_SIZES) {
        await putSettings(info, { theme, language: 'it', density: 'comfortable', expertMode: opts.expert ?? false, onboardingDone: true });
        const context = await browser.newContext({ viewport: { width: size.w, height: size.h }, deviceScaleFactor: 1, reducedMotion: 'reduce', colorScheme: theme, locale: 'it-IT' });
        const page = await context.newPage();
        await page.goto(`${info.url}#${route}`);
        await page.getByText(wait).first().waitFor({ timeout: 120000 });
        if (opts.act) await opts.act(page);
        await page.evaluate(() => document.fonts.ready);
        await page.waitForTimeout(1500);
        await page.mouse.move(size.w - 4, size.h - 4);
        const file = path.join(outDir, `${n}-${name}-${theme}${size.suffix}.png`);
        await shoot(page, file);
        written.push(file);
        if (!size.suffix) {
          const fullFile = file.replace(/\.png$/, '-full.png');
          await shoot(page, fullFile, { full: true });
          written.push(fullFile);
        }
        await context.close();
      }
    }
  };
  /** Expert mode, the 27B, the whole 256K context: the plan says it will not fit. */
  const wholeContext = async (page) => {
    await chooseModel(page, QWEN_27B);
    await page.getByLabel('Contesto (token)').fill('262144');
    await page.getByText('Il modello non entra tutto nella scheda video').first().waitFor({ timeout: 30000 });
    await page.getByText('Il modello non entra tutto nella scheda video').first().scrollIntoViewIfNeeded();
  };
  /** "Avvia benchmark", and the one-time llama.cpp install when it is the first run. */
  const start = async (page) => {
    await page.getByRole('button', { name: 'Avvia benchmark' }).click();
    const confirm = page.getByRole('button', { name: 'Scarica e avvia' });
    if (await confirm.waitFor({ timeout: 3000 }).then(() => true, () => false)) await confirm.click();
    await page.getByRole('heading', { level: 1, name: 'Test in corso' }).waitFor({ timeout: 60000 });
    return (await api(info, 'GET', '/api/runs/active')).active.runId;
  };
  try {
    await idle(info);
    await putSettings(info, { theme: 'light', language: 'it', expertMode: false, onboardingDone: true });
    const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, reducedMotion: 'reduce', locale: 'it-IT' });
    const page = await context.newPage();
    if (want('spill-live') || want('benchmark-spill')) {
      // A clean Rapido: the usual speed of this model here.
      writeFileSync(world.profileFile, JSON.stringify(SPILL_SHOT_PROFILE));
      await page.goto(`${info.url}#/`);
      await page.getByText('Pronto a misurare').first().waitFor({ timeout: 30000 });
      await chooseModel(page, QWEN_27B);
      await page.getByRole('radio', { name: /Rapido/ }).click();
      await start(page);
      while ((await api(info, 'GET', '/api/runs/active')).active) await sleep(1000);
    }

    if (want('benchmark-spill')) await shotAll(33, 'benchmark-spill', '/', 'Pronto a misurare', { expert: true, act: wholeContext, sizes: [{ w: 1440, h: 900, suffix: '' }] });

    if (want('spill-live')) {
      // The whole context, a short custom plan (the banner comes after its first measurement).
      await putSettings(info, { theme: 'light', language: 'it', expertMode: true, onboardingDone: true });
      await page.goto(`${info.url}#/`);
      await page.getByText('Pronto a misurare').first().waitFor({ timeout: 30000 });
      await chooseModel(page, QWEN_27B);
      await page.getByRole('radio', { name: /Personalizzato/ }).click();
      await page.getByLabel('Caricamenti a freddo').fill('0');
      await page.getByLabel('Caricamenti a caldo').fill('1');
      await page.getByLabel('Lunghezze dei prompt').fill('512, 4096');
      await page.getByLabel('Token generati').fill('32');
      await page.getByLabel('Ripetizioni', { exact: true }).fill('3');
      await page.getByLabel('Ripetizioni di riscaldamento').fill('0');
      await page.getByLabel('Contesto (token)').fill('262144');
      const runId = await start(page);
      await page.getByText('Sta usando la RAM condivisa: i numeri saranno molto più bassi').waitFor({ timeout: 180000 });
      await shotAll(31, 'spill-live', `/run/${runId}`, 'Sta usando la RAM condivisa', { sizes: [{ w: 1440, h: 900, suffix: '' }, { w: 1024, h: 680, suffix: '-1024' }] });
      await idle(info);
    }

    if (want('tune-partial')) {
      writeFileSync(world.profileFile, JSON.stringify(TUNE_PARTIAL_PROFILE));
      await putSettings(info, { theme: 'light', language: 'it', expertMode: false, onboardingDone: true });
      await page.goto(`${info.url}#/`);
      await page.getByText('Pronto a misurare').first().waitFor({ timeout: 30000 });
      await chooseModel(page, /^Qwen3[ -]8B/);
      await chooseTune(page);
      const runId = await start(page);
      while ((await api(info, 'GET', '/api/runs/active')).active) await sleep(2000);
      // What the search did, in one line (its time limit, what it measured).
      const run = await api(info, 'GET', `/api/runs/${runId}`);
      const t = run.tuning;
      const combos = t?.combinations.map((c) => `${c.kvType}@${c.maxContext}:${c.sweep.map((p) => p.promptTokens).join('/')}${c.partial ? `(${c.partial})` : ''}`);
      console.log(`tune-partial: ${run.status} stoppedBy=${t?.stoppedBy} estimate=${t?.estimateSeconds}s limit=${t?.limitSeconds}s attempts=${t?.attempts.length} combinations=${combos?.join(', ')}`);
      await shotAll(32, 'tune-partial', `/results/${runId}`, 'Mi sono fermato prima');
    }
    await context.close();
  } finally {
    await idle(info).catch(() => undefined);
    writeFileSync(world.profileFile, JSON.stringify(LIVE_PROFILE));
  }
}

async function shoot(page, file, { full } = {}) {
  if (full) {
    // The page scrolls inside <main>: grow the viewport to the content so one image shows it all.
    const h = await page.evaluate(() => {
      const main = document.getElementById('main');
      // App pages scroll inside <main>; a plain document (the exported sheet) scrolls itself.
      return main ? Math.ceil(main.scrollHeight + main.getBoundingClientRect().top) : document.documentElement.scrollHeight;
    });
    const vp = page.viewportSize();
    await page.setViewportSize({ width: vp.width, height: Math.max(vp.height, h) });
    await page.waitForTimeout(400);
    await page.screenshot({ path: file });
    await page.setViewportSize(vp);
    return;
  }
  await page.screenshot({ path: file });
}

async function main() {
  if (!args.has('--no-build')) execFileSync(process.execPath, [path.join(root, 'scripts/build.mjs')], { stdio: 'inherit', cwd: root });
  mkdirSync(outDir, { recursive: true });
  const dataDir = mkdtempSync(path.join(os.tmpdir(), 'gpubench-mockups-'));
  const world = await fakeWorld(dataDir);
  const { proc, info } = await startCore(dataDir, world.env);
  const browser = await chromium.launch();
  const written = [];
  try {
    for (const theme of ['light', 'dark']) {
      for (const size of [
        { w: 1440, h: 900, suffix: '' },
        { w: 1024, h: 680, suffix: '-1024' },
      ]) {
        const context = await browser.newContext({
          viewport: { width: size.w, height: size.h },
          deviceScaleFactor: 1,
          reducedMotion: 'reduce',
          colorScheme: theme,
          locale: 'it-IT',
        });
        const page = await context.newPage();
        for (const s of SCREENS) {
          if (only && !only.includes(s.name)) continue;
          if (size.suffix && !s.small) continue;
          await putSettings(info, { theme, language: 'it', density: 'comfortable', expertMode: false, onboardingDone: true, ...s.settings });
          if (s.route === 'LIVE') await openLiveRun(page, info);
          else await page.goto(`${info.url}#${s.route}`);
          await page.getByText(s.wait).first().waitFor({ timeout: 30000 });
          await page.evaluate(() => document.fonts.ready);
          if (s.tab) {
            await page.getByRole('tab', { name: s.tab }).click();
            await page.evaluate(() => document.activeElement?.blur?.());
          }
          if (s.click) await page.getByRole(s.click.role, { name: s.click.name }).click();
          if (s.keys) await page.keyboard.press(s.keys);
          if (s.act) await s.act(page);
          await page.waitForTimeout(s.settle ?? 900);
          // Move the pointer away so no hover state or tooltip leaks into the image.
          await page.mouse.move(size.w - 4, size.h - 4);
          const file = path.join(outDir, `${s.n}-${s.name}-${theme}${size.suffix}.png`);
          await shoot(page, file);
          written.push(file);
          if (!size.suffix && (s.full || ['benchmark', 'result', 'run'].includes(s.name))) {
            const fullFile = file.replace(/\.png$/, '-full.png');
            await shoot(page, fullFile, { full: true });
            written.push(fullFile);
          }
          // Screens that changed what is on the page leave it fresh for the next ones.
          if (s.after) await s.after(info);
          if (s.act) await page.reload();
        }
        await context.close();
      }
    }
    await tuneScenes(browser, info, world, written);
    await spillScenes(browser, info, world, written);
  } finally {
    await browser.close();
    const active = await api(info, 'GET', '/api/runs/active').catch(() => ({ active: null }));
    if (active.active) await api(info, 'POST', `/api/runs/${active.active.runId}/cancel`).catch(() => undefined);
    await sleep(500);
    proc.kill();
    await world.close();
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  }
  for (const f of written) console.log(path.relative(root, f));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
