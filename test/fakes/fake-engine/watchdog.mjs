// Watchdog for a fake engine: when the engine process disappears (even killed with
// taskkill /F or SIGKILL), give its VRAM/util/power contribution back to the fake
// nvidia-smi state. `--launch` re-spawns itself detached and exits at once, so the real
// watchdog is not a descendant of the engine and survives tree kills.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { releaseContribution } from './gpu-state.mjs';

const args = process.argv.slice(2);
if (args[0] === '--launch') {
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), ...args.slice(1)], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
  process.exit(0);
}

const [ppidText, file, sidecar] = args;
const ppid = Number(ppidText);
const started = Date.now();
const MAX_LIFE_MS = 30 * 60_000;

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return /** @type {NodeJS.ErrnoException} */ (e).code === 'EPERM';
  }
};

const timer = setInterval(() => {
  if (alive(ppid) && Date.now() - started < MAX_LIFE_MS) return;
  clearInterval(timer);
  releaseContribution(/** @type {string} */ (file), /** @type {string} */ (sidecar));
  process.exit(0);
}, 50);
