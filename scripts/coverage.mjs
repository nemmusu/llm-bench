// Merges coverage from every test layer into one report and enforces the 100% gate.
//
//   .qa/coverage-unit/coverage-final.json   Vitest (istanbul data produced by ast-v8-to-istanbul)
//   .qa/cov-e2e/*.json                       raw V8 from Electron main + core (NODE_V8_COVERAGE)
//   .qa/cov-renderer/*.json                  raw V8 from the renderer (Playwright page.coverage)
//
// Raw V8 is converted with the same ast-v8-to-istanbul + source maps that Vitest uses, so both sides
// describe the original TypeScript with identical statement/branch maps and can be merged safely.
//
//   node scripts/coverage.mjs            report + gate (exit 1 below 100%)
//   node scripts/coverage.mjs --no-gate  report only
import { convert } from 'ast-v8-to-istanbul';
import { parseAstAsync } from 'vite';
import libCoverage from 'istanbul-lib-coverage';
import libReport from 'istanbul-lib-report';
import reports from 'istanbul-reports';
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const qa = path.join(root, '.qa');
const gate = !process.argv.includes('--no-gate');
const srcDir = path.join(root, 'src') + path.sep;

const norm = (p) => path.resolve(p);
const isOurSource = (file) => norm(file).startsWith(srcDir) && !file.endsWith('.d.ts');

/**
 * Canonical per-file data, keyed by absolute source path. Vitest's map (which includes every file
 * under src/, even unloaded ones) is the reference; E2E hits are added to the statement/function/
 * branch at the same source location. Bundling can add a few artifacts (e.g. `import` lines
 * become statements in esbuild's CJS output): those have no counterpart and are ignored.
 */
const canonical = new Map();

const locKey = (l) => {
  const end = l.end.column == null || l.end.column === Infinity ? 'E' : l.end.column;
  return `${l.start.line}:${l.start.column}-${l.end.line}:${end}`;
};

function indexBy(map, keyOf) {
  const out = new Map();
  for (const [id, v] of Object.entries(map)) out.set(keyOf(v), id);
  return out;
}

function mergeFile(abs, data) {
  const base = canonical.get(abs);
  if (!base) {
    canonical.set(abs, structuredClone({ ...data, path: abs }));
    return;
  }
  const st = indexBy(base.statementMap, locKey);
  for (const [id, loc] of Object.entries(data.statementMap)) {
    const target = st.get(locKey(loc));
    if (target !== undefined) base.s[target] += data.s[id] ?? 0;
  }
  const fn = indexBy(base.fnMap, (f) => locKey(f.loc));
  for (const [id, f] of Object.entries(data.fnMap)) {
    const target = fn.get(locKey(f.loc));
    if (target !== undefined) base.f[target] += data.f[id] ?? 0;
  }
  const br = indexBy(base.branchMap, (b) => locKey(b.loc) + b.type);
  for (const [id, b] of Object.entries(data.branchMap)) {
    const target = br.get(locKey(b.loc) + b.type);
    if (target === undefined) continue;
    const dst = base.b[target];
    const src = data.b[id] ?? [];
    if (dst.length !== src.length) continue;
    for (let i = 0; i < dst.length; i++) dst[i] += src[i] ?? 0;
  }
}

function addFiltered(data) {
  for (const [file, cov] of Object.entries(data)) {
    const abs = norm(file);
    if (!isOurSource(abs)) continue;
    mergeFile(abs, cov);
  }
}

// 1. Unit/integration (Vitest).
const unitFile = path.join(qa, 'coverage-unit', 'coverage-final.json');
if (existsSync(unitFile)) addFiltered(JSON.parse(readFileSync(unitFile, 'utf8')));
else console.warn('[coverage] no unit coverage found at', unitFile);

// 2. Raw V8 → istanbul.
const sourceMapCache = new Map();
function loadBundle(fileOnDisk) {
  if (!sourceMapCache.has(fileOnDisk)) {
    const code = readFileSync(fileOnDisk, 'utf8');
    const mapFile = `${fileOnDisk}.map`;
    const sourceMap = existsSync(mapFile) ? JSON.parse(readFileSync(mapFile, 'utf8')) : undefined;
    if (sourceMap) {
      // Make sources absolute so the result is keyed by real file paths.
      const base = path.dirname(fileOnDisk);
      sourceMap.sources = sourceMap.sources.map((s) => norm(path.resolve(base, sourceMap.sourceRoot ?? '', s)));
      sourceMap.sourceRoot = '';
    }
    sourceMapCache.set(fileOnDisk, { code, sourceMap });
  }
  return sourceMapCache.get(fileOnDisk);
}

/** Maps a script URL from V8 to the bundle on disk (out/…). */
function bundleFor(url) {
  if (url.startsWith('file://')) {
    const p = fileURLToPath(url);
    return norm(p).startsWith(norm(path.join(root, 'out')) + path.sep) ? p : undefined;
  }
  const m = /^http:\/\/(?:127\.0\.0\.1|localhost):\d+\/(.+)$/.exec(url);
  if (m) {
    const p = path.join(root, 'out', 'renderer', decodeURIComponent(m[1].split('?')[0]));
    return existsSync(p) ? p : undefined;
  }
  return undefined;
}

async function addV8(entries, source) {
  for (const entry of entries) {
    const bundle = bundleFor(entry.url);
    if (!bundle) continue;
    const { code, sourceMap } = loadBundle(bundle);
    if (!sourceMap) continue;
    const scriptCode = entry.source ?? code;
    if (scriptCode !== code) continue; // stale dump from an older build
    const data = await convert({
      ast: parseAstAsync(code),
      code,
      wrapperLength: 0,
      coverage: { url: pathToFileURL(bundle).href, functions: entry.functions, scriptId: '0' },
      sourceMap,
    });
    addFiltered(data);
  }
  console.log(`[coverage] merged ${source}`);
}

for (const dir of ['cov-e2e', 'cov-renderer']) {
  const full = path.join(qa, dir);
  if (!existsSync(full)) continue;
  for (const f of readdirSync(full).filter((x) => x.endsWith('.json'))) {
    const json = JSON.parse(readFileSync(path.join(full, f), 'utf8'));
    await addV8(json.result ?? json, `${dir}/${f}`);
  }
}

// 3. Reports.
const map = libCoverage.createCoverageMap({});
for (const data of canonical.values()) map.addFileCoverage(data);
const outDir = path.join(qa, 'coverage');
mkdirSync(outDir, { recursive: true });
const context = libReport.createContext({ dir: outDir, coverageMap: map, defaultSummarizer: 'nested' });
for (const name of ['html', 'json-summary', 'text-summary']) reports.create(name).execute(context);

// 4. Gate: every file, every metric, 100%.
const failures = [];
for (const file of map.files()) {
  const s = map.fileCoverageFor(file).toSummary();
  const bad = ['statements', 'branches', 'functions', 'lines'].filter((k) => s[k].total > 0 && s[k].pct < 100);
  if (bad.length) failures.push(`${path.relative(root, file)}: ${bad.map((k) => `${k} ${s[k].pct}%`).join(', ')}`);
}

// Every source file must be present (a file never loaded by any test is 0% covered).
const allSources = [];
const walk = (d) => {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.(ts|tsx)$/.test(e.name) && !e.name.endsWith('.d.ts')) allSources.push(norm(p));
  }
};
walk(path.join(root, 'src'));
const covered = new Set(map.files().map(norm));
// Type-only modules produce no executable code; they appear with 0 statements and are fine.
for (const f of allSources) if (!covered.has(f)) failures.push(`${path.relative(root, f)}: never loaded by any test`);

writeFileSync(path.join(outDir, 'gate.txt'), failures.join('\n') + '\n');
if (failures.length) {
  console.log(`\n[coverage] ${failures.length} file(s) below 100%:\n  ` + failures.join('\n  '));
  if (gate) process.exit(1);
} else {
  console.log('\n[coverage] 100% on every file ✔');
}
