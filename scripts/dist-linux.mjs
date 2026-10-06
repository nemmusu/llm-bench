// Builds the Linux packages (.deb + AppImage) inside the official electron-builder Docker image,
// so they can be produced from Windows too (electron-builder cannot build .deb natively there).
//
//   node scripts/dist-linux.mjs            → dist/linux/gpu-bench-<version>-amd64.deb, …AppImage
//
// The committed sources (git archive of HEAD) are copied into the container: no Windows
// node_modules or build output leaks into the Linux build.
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'dist', 'linux');
const archive = path.join(root, '.qa', 'src-head.tar');
const IMAGE = 'electronuserland/builder:24';

function run(cmd, args) {
  const r = spawnSync(cmd, args, { cwd: root, stdio: 'inherit' });
  if (r.status !== 0) {
    console.error(`✖ ${cmd} ${args.slice(0, 3).join(' ')}… failed (${r.status})`);
    process.exit(r.status ?? 1);
  }
}

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
mkdirSync(path.dirname(archive), { recursive: true });
run('git', ['archive', '--format=tar', '-o', archive, 'HEAD']);

const script = [
  'set -euo pipefail',
  'mkdir -p /build && tar -xf /in/src-head.tar -C /build',
  'cd /build',
  'npm ci --no-audit --no-fund',
  'node scripts/build.mjs --production',
  'npx electron-builder --linux deb AppImage --publish never',
  'cp dist/*.deb dist/*.AppImage /out/',
  'chown -R "$HOST_UID:$HOST_GID" /out 2>/dev/null || true',
].join(' && ');

run('docker', [
  'run',
  '--rm',
  '-e',
  'HOST_UID=1000',
  '-e',
  'HOST_GID=1000',
  '-v',
  `${path.dirname(archive)}:/in:ro`,
  '-v',
  `${outDir}:/out`,
  IMAGE,
  'bash',
  '-lc',
  script,
]);
console.log(`✔ Linux packages in ${outDir}`);
