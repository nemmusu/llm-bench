// One command for "is this shippable?":
//   lint → typecheck → architecture boundaries → build → unit/integration (coverage) →
//   E2E on the real Electron app (coverage) → merged 100% coverage gate.
//
//   node scripts/validate.mjs            everything
//   node scripts/validate.mjs --fast     skip E2E (coverage gate reported, not enforced)
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fast = process.argv.includes('--fast');
const qa = path.join(root, '.qa');
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';

function step(name, cmd, args, env = {}) {
  const started = Date.now();
  process.stdout.write(`\n▶ ${name}\n`);
  const r = spawnSync(cmd, args, {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, ...env },
    // npx is a .cmd on Windows: it needs a shell (arguments here are fixed, never user input).
    shell: process.platform === 'win32' && cmd === npx,
  });
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  if (r.status !== 0) {
    console.error(`\n✖ ${name} failed (${secs}s)`);
    process.exit(r.status ?? 1);
  }
  console.log(`✔ ${name} (${secs}s)`);
}

for (const d of ['coverage-unit', 'cov-e2e', 'cov-renderer', 'coverage']) rmSync(path.join(qa, d), { recursive: true, force: true });
mkdirSync(path.join(qa, 'cov-e2e'), { recursive: true });

step('lint', npx, ['eslint', '.']);
step('typecheck', npx, ['tsc', '-p', 'tsconfig.json', '--noEmit']);
step('architecture boundaries', npx, ['depcruise', 'src', '--config', '.dependency-cruiser.cjs']);
step('coverage ignore budget', process.execPath, ['scripts/check-coverage-ignores.mjs']);
step('build', process.execPath, ['scripts/build.mjs']);
step('unit + integration tests', npx, ['vitest', 'run', '--coverage']);
if (!fast) {
  step('E2E (Electron)', npx, ['playwright', 'test'], {
    GPUBENCH_HIDE_WINDOW: '1',
    GPUBENCH_E2E_COVERAGE: path.join(qa, 'cov-e2e'),
  });
}
step('coverage gate (100%)', process.execPath, ['scripts/coverage.mjs', ...(fast ? ['--no-gate'] : [])]);
console.log('\n✔ validate: all green');
