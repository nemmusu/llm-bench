// Renders the design mockups of the key screens to .qa/mockups/*.png (light + dark).
//
//   node scripts/mockups.mjs              build, then screenshot everything
//   node scripts/mockups.mjs --no-build   reuse the current out/ folder
//   node scripts/mockups.mjs --only=result,run
//
// How it works: the core starts in browser mode (`node out/core/index.cjs`) with a throw-away
// GPUBENCH_DATA_DIR, so the real settings file is never touched. The theme (and language,
// onboarding, expert mode) is set with PUT /api/settings before each navigation: the same path the
// UI uses, no special dev hooks. Chromium runs with reduced motion so charts render without
// animation and frames are stable. Screens with mock data are reached by URL (hash routes).
import { chromium } from '@playwright/test';
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = new Set(process.argv.slice(2));
const only = [...args].find((a) => a.startsWith('--only='))?.slice(7).split(',');
const outDir = path.join(root, '.qa', 'mockups');

// Ids of the mock runs (src/renderer/mock/runs.ts).
const RESULT_ID = '01K6Y7Q2ZC4M8N3B5V9R1T0XWE';
const LIVE_ID = '01K6YB3H8F2D6S9K4P7M1Q5ZRA';

/** n, name, route, settings patch, optional page action, and which sizes to render. */
const SCREENS = [
  { n: 1, name: 'welcome', route: '/welcome', wait: 'Controllo del sistema' },
  { n: 2, name: 'benchmark', route: '/', wait: 'Avvia benchmark', small: true },
  { n: 3, name: 'run', route: `/run/${LIVE_ID}`, wait: 'Test in corso', settle: 1600 },
  { n: 4, name: 'result', route: `/results/${RESULT_ID}`, wait: 'Punteggio GPU Bench', small: true },
  { n: 5, name: 'benchmark-expert', route: '/', wait: 'Anteprima comando', settings: { expertMode: true }, full: true },
  { n: 6, name: 'result-launch', route: `/results/${RESULT_ID}`, wait: 'Punteggio GPU Bench', tab: 'Come è stato avviato' },
  { n: 7, name: 'model-picker', route: '/', wait: 'Avvia benchmark', click: { role: 'button', name: /Cambia modello/ } },
  { n: 8, name: 'results', route: '/results', wait: 'Risultati' },
  { n: 9, name: 'monitor', route: '/monitor', wait: 'Monitor GPU', settle: 900 },
  { n: 10, name: 'settings', route: '/settings', wait: 'Impostazioni' },
  { n: 11, name: 'palette', route: '/', wait: 'Avvia benchmark', keys: 'Control+K' },
  { n: 12, name: 'result-en', route: `/results/${RESULT_ID}`, wait: 'GPU Bench score', settings: { language: 'en' } },
];

function startCore(dataDir) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [path.join(root, 'out/core/index.cjs')], {
      env: { ...process.env, GPUBENCH_DATA_DIR: dataDir, GPUBENCH_MODELS_DIR: path.join(dataDir, 'models') },
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

async function putSettings(info, patch) {
  const res = await fetch(`http://127.0.0.1:${info.port}/api/settings`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${info.token}`, 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error(`PUT /api/settings → ${res.status}`);
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
  const { proc, info } = await startCore(dataDir);
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
          await page.goto(`${info.url}#${s.route}`);
          await page.getByText(s.wait).first().waitFor({ timeout: 15000 });
          await page.evaluate(() => document.fonts.ready);
          if (s.tab) {
            await page.getByRole('tab', { name: s.tab }).click();
            await page.evaluate(() => document.activeElement?.blur?.());
          }
          if (s.click) await page.getByRole(s.click.role, { name: s.click.name }).click();
          if (s.keys) await page.keyboard.press(s.keys);
          await page.waitForTimeout(s.settle ?? 700);
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
        }
        await context.close();
      }
    }
  } finally {
    await browser.close();
    proc.kill();
    rmSync(dataDir, { recursive: true, force: true });
  }
  for (const f of written) console.log(path.relative(root, f));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
