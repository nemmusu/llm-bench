// Renders the tray icons from resources/icons/icon.svg into resources/icons/tray/ (run once when the
// mark changes; the PNGs are committed):
//
//   idle.png     16 px   the app mark                       (Windows; @2x = 32 px for 200 % screens)
//   running.png  16 px   the mark with a green dot          a server is running
//   loading.png  16 px   the mark with an amber dot         a server is starting
//   *-linux.png  32 px   the same at the size Linux panels scale down from
//
//   node scripts/tray-icons.mjs
import { chromium } from '@playwright/test';
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'resources', 'icons', 'tray');
const mark = readFileSync(path.join(root, 'resources', 'icons', 'icon.svg'), 'utf8').replace(/<!--[\s\S]*?-->/g, '');

/** Status dots: the brand's success and warning colours, with a light ring so they read on any taskbar. */
const DOTS = { idle: undefined, running: '#16a34a', loading: '#f59e0b' };

function page(size, dot) {
  const icon = mark.replace(/width="512" height="512"/, `width="${size}" height="${size}"`);
  const r = size * 0.24;
  const c = size - r - size * 0.02;
  const overlay = dot
    ? `<svg style="position:absolute;left:0;top:0" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}"><circle cx="${c}" cy="${c}" r="${r + size * 0.06}" fill="#ffffff"/><circle cx="${c}" cy="${c}" r="${r}" fill="${dot}"/></svg>`
    : '';
  return `<!doctype html><html><body style="margin:0;background:transparent"><div style="position:relative;width:${size}px;height:${size}px">${icon}${overlay}</div></body></html>`;
}

mkdirSync(out, { recursive: true });
const browser = await chromium.launch();
try {
  for (const [status, dot] of Object.entries(DOTS)) {
    for (const [size, name] of [
      [16, `${status}.png`],
      [32, `${status}@2x.png`],
      [32, `${status}-linux.png`],
    ]) {
      const p = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
      await p.setContent(page(size, dot));
      await p.screenshot({ path: path.join(out, name), omitBackground: true });
      await p.close();
      console.log(path.relative(root, path.join(out, name)));
    }
  }
} finally {
  await browser.close();
}
