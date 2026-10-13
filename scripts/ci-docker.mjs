// Local CI in Docker: validates the COMMITTED code (git HEAD) in a clean Linux container, exactly
// as it would be pushed. Nothing from this PC's node_modules or build output goes in.
//
//   npm run ci:docker            validate HEAD (lint, types, tests, E2E under Xvfb, 100% gate)
//   npm run ci:docker -- --fast  same without the E2E
//
// Caches (npm, Electron download) live in named Docker volumes, so the second run is quicker.
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fast = process.argv.includes('--fast');
const image = 'llm-bench-ci';
const work = path.join(root, '.qa', 'ci');

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { cwd: root, stdio: 'inherit', ...opts });
  if (r.error) throw r.error;
  return r.status ?? 1;
}

function git(args) {
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

const head = git(['rev-parse', '--short', 'HEAD']);
if (git(['status', '--porcelain', '--untracked-files=no'])) {
  console.warn(`! Ci sono modifiche non salvate: valido solo il commit ${head}, non quelle.`);
}

rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });
if (run('git', ['archive', '--format=tar', '-o', path.join(work, 'src.tar'), 'HEAD']) !== 0) process.exit(1);

console.log(`\n▶ immagine ${image}`);
if (run('docker', ['build', '-t', image, path.join(root, 'scripts', 'ci')]) !== 0) process.exit(1);

const inner = [
  'set -e',
  'tar -xf /in/src.tar -C /work',
  'npm ci --no-audit --no-fund',
  `xvfb-run -a --server-args="-screen 0 1600x1000x24" node scripts/validate.mjs${fast ? ' --fast' : ''}`,
].join(' && ');

console.log(`\n▶ validate di ${head} in Linux${fast ? ' (senza E2E)' : ''}`);
const started = Date.now();
const status = run('docker', [
  'run', '--rm', '--init', '--shm-size=2g',
  '-v', `${work}:/in:ro`,
  '-v', 'llm-bench-ci-npm:/root/.npm',
  '-v', 'llm-bench-ci-electron:/root/.cache/electron',
  image, 'bash', '-lc', inner,
]);
rmSync(work, { recursive: true, force: true });
const mins = ((Date.now() - started) / 60000).toFixed(1);
console.log(status === 0 ? `\n✔ CI locale (Linux): tutto verde su ${head} in ${mins} min` : `\n✖ CI locale (Linux): fallita su ${head} dopo ${mins} min`);
process.exit(status);
