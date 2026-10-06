// Builds the three Node bundles (main, preload, core) with esbuild and the renderer with Vite.
//   node scripts/build.mjs               development build (sourcemaps)
//   node scripts/build.mjs --watch       rebuild on change
//   node scripts/build.mjs --production  minified, used by `npm run dist`
//   node scripts/build.mjs --only=core   build a single target (main|preload|core|renderer)
import { build as esbuild, context as esbuildContext } from 'esbuild';
import { build as viteBuild } from 'vite';
import { readFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = new Set(process.argv.slice(2));
const watch = args.has('--watch');
const production = args.has('--production');
const only = [...args].find((a) => a.startsWith('--only='))?.slice('--only='.length);
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));

const define = {
  __APP_VERSION__: JSON.stringify(pkg.version),
  'process.env.NODE_ENV': JSON.stringify(production ? 'production' : 'development'),
};

/** @type {import('esbuild').BuildOptions} */
const common = {
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  sourcemap: 'linked',
  sourcesContent: true,
  minify: false,
  logLevel: 'warning',
  define,
  legalComments: 'none',
};

const targets = {
  main: { ...common, entryPoints: [path.join(root, 'src/main/index.ts')], outfile: path.join(root, 'out/main/index.cjs'), external: ['electron'] },
  preload: { ...common, entryPoints: [path.join(root, 'src/preload/index.ts')], outfile: path.join(root, 'out/preload/index.cjs'), external: ['electron'] },
  core: { ...common, entryPoints: [path.join(root, 'src/core/entry.ts')], outfile: path.join(root, 'out/core/index.cjs') },
};

async function buildNode(name) {
  const opts = targets[name];
  if (watch) {
    const ctx = await esbuildContext(opts);
    await ctx.watch();
    console.log(`[build] watching ${name}`);
  } else {
    await esbuild(opts);
    console.log(`[build] ${name} ok`);
  }
}

async function buildRenderer() {
  await viteBuild({
    configFile: path.join(root, 'vite.config.ts'),
    mode: production ? 'production' : 'development',
    logLevel: 'warn',
    build: watch ? { watch: {} } : {},
  });
  console.log(`[build] renderer ${watch ? 'watching' : 'ok'}`);
}

if (!only && !watch) rmSync(path.join(root, 'out'), { recursive: true, force: true });

const jobs = [];
for (const name of ['main', 'preload', 'core']) if (!only || only === name) jobs.push(buildNode(name));
if (!only || only === 'renderer') jobs.push(buildRenderer());
await Promise.all(jobs);
