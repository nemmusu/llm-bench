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
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { startFakeDockerApi } from '../test/fakes/fake-docker/api.mjs';
import { startFakeGithub } from '../test/fakes/fake-github/server.mjs';
import { demoRepos, startFakeHub } from '../test/fakes/fake-hub/hub.mjs';
import { buildGguf, llamaLikeGguf } from '../test/fakes/fake-hub/model-files.mjs';
import { TUNE_PROFILE } from '../test/fakes/fake-engine/profiles.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = new Set(process.argv.slice(2));
const only = [...args].find((a) => a.startsWith('--only='))?.slice(7).split(',');
const outDir = path.join(root, '.qa', 'mockups');

// Seeded runs (test/fixtures/runs).
const RESULT_ID = '01K6Y7Q2ZC4M8N3B5V9R1T0XWE';
const COMPARE_A = '01K6TZ5G1H4J7K2L8Z3X6C9VBN';
const FAILED_ID = '01K6NA2S5D8F1G4H7J3K6L9ZXC';

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

/** Stops every server a scene started (the next screens, the live run above all, need a free GPU). */
async function stopServers(info) {
  for (const s of await api(info, 'GET', '/api/servers')) await api(info, 'DELETE', `/api/servers/${encodeURIComponent(s.id)}`);
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
  // The "Trova le impostazioni migliori" choice with its options (the run and the result: tuneScenes).
  { n: 22, name: 'benchmark-tune', route: '/', wait: 'Pronto a misurare', act: chooseTune, small: true, full: true },
];

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

/** Fake world (see test/e2e/global-setup.ts) and a data folder with models, runs and settings. */
async function fakeWorld(dataDir) {
  const cli = path.join(root, 'test', 'fakes', 'fake-engine', 'cli.mjs');
  const github = await startFakeGithub({ serverBinaryData: `import(${JSON.stringify(pathToFileURL(cli).href)});\n` });
  const hub = await startFakeHub({
    repos: [
      ...demoRepos(),
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
  const models = path.join(dataDir, 'models', 'local');
  mkdirSync(models, { recursive: true });
  writeFileSync(path.join(models, 'Qwen3-8B-Q4_K_M.gguf'), buildGguf({ ...llamaLikeGguf({ name: 'Qwen3 8B', sizeLabel: '8B' }), totalSize: 96 * 1024 }));
  writeFileSync(path.join(models, 'gemma-4-12b-it-Q4_K_M.gguf'), buildGguf({ ...llamaLikeGguf({ name: 'Gemma 4 12B', sizeLabel: '12B' }), totalSize: 128 * 1024 }));
  const results = path.join(dataDir, 'results');
  mkdirSync(results, { recursive: true });
  const seeds = path.join(root, 'test', 'fixtures', 'runs');
  const hostId = thisHostId();
  for (const f of readdirSync(seeds).filter((x) => x.endsWith('.json'))) {
    writeFileSync(path.join(results, f), readFileSync(path.join(seeds, f), 'utf8').replaceAll('__THIS_HOST_ID__', hostId).replaceAll('__THIS_PC__', os.hostname()));
  }
  writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify({ scanKnownLocations: false, onboardingDone: true }));
  const profileFile = path.join(dataDir, 'fake-engine-profile.json');
  writeFileSync(profileFile, JSON.stringify(LIVE_PROFILE));
  const smiState = path.join(dataDir, 'fake-nvidia-smi.json');
  writeFileSync(smiState, JSON.stringify({ gpus: [{ memUsedMiB: 1600, powerW: 38, utilPct: 1, tempC: 39 }] }));
  const env = {
    GPUBENCH_GITHUB_API: github.url,
    GPUBENCH_HF_ENDPOINT: hub.url,
    GPUBENCH_DOCKER_HOST: dockerApi.socketPath,
    GPUBENCH_DOCKER: JSON.stringify([process.execPath, path.join(root, 'test', 'fakes', 'fake-docker', 'fake-docker.mjs')]),
    FAKE_DOCKER_STATE: path.join(dataDir, 'fake-docker'),
    GPUBENCH_NVIDIA_SMI: JSON.stringify([process.execPath, path.join(root, 'test', 'fakes', 'fake-nvidia-smi', 'fake-nvidia-smi.mjs')]),
    FAKE_NVIDIA_SMI_STATE: smiState,
    GPUBENCH_LLAMA_LAUNCHER: JSON.stringify([process.execPath]),
    // A file the fake engine reads at every launch: the tune scenes switch it to the tuner's profile.
    FAKE_ENGINE_PROFILE: profileFile,
    FAKE_ENGINE_ALLOW_MISSING_MODEL: '1',
  };
  return { env, profileFile, close: () => Promise.all([github.close(), hub.close(), dockerApi.close()]) };
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
        if (!size.suffix) {
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
    if (want('tune-run')) await shots(20, 'tune-run', `/run/${runId}`, 'Prove fatte');
    while ((await api(info, 'GET', '/api/runs/active')).active) await sleep(1000);
    if (want('tune-result')) await shots(21, 'tune-result', `/results/${runId}`, 'Classifica delle combinazioni');
  } finally {
    writeFileSync(world.profileFile, JSON.stringify(LIVE_PROFILE));
  }
}

async function shoot(page, file, { full } = {}) {
  if (full) {
    // The page scrolls inside <main>: grow the viewport to the content so one image shows it all.
    const h = await page.evaluate(() => {
      const main = document.getElementById('main');
      return Math.ceil((main?.scrollHeight ?? 900) + (main?.getBoundingClientRect().top ?? 40));
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
