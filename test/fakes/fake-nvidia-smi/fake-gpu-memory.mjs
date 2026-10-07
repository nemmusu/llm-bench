#!/usr/bin/env node
/**
 * Fake per-process GPU memory monitor for tests: the stand-in for the Windows counters' monitor
 * (src/core/telemetry/process-vram.ts windowsMonitorScript), speaking the same protocol:
 *   node test/fakes/fake-nvidia-smi/fake-gpu-memory.mjs --interval-ms N --parent PID
 * Wire it with CoreEndpoints.gpuMemoryMonitor (GPUBENCH_GPU_MEMORY_MONITOR='["node","…/fake-gpu-memory.mjs"]').
 *
 * Every interval it prints `N <pid> llama-server` for an engine seen for the first time and one
 * `S <pid>=<dedicated bytes>/<shared bytes> …` line, from the fake engines' sidecars next to the fake
 * nvidia-smi state (FAKE_NVIDIA_SMI_STATE + ".engine-<pid>.json": memMiB, sharedMiB; see
 * test/fakes/fake-engine/gpu-state.mjs). Engines that are gone are left out. It exits when the parent
 * (the core) is gone or its output is closed.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const MIB = 1024 * 1024;
const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] !== undefined ? Number(argv[i + 1]) : fallback;
};
const intervalMs = Math.max(50, arg('--interval-ms', 1000));
const parent = arg('--parent', process.ppid);
const state = process.env.FAKE_NVIDIA_SMI_STATE;

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return /** @type {NodeJS.ErrnoException} */ (e).code === 'EPERM';
  }
};

/** pid → { memMiB, sharedMiB } of every fake engine still running. */
function engines() {
  const out = new Map();
  if (!state) return out;
  const dir = path.dirname(state);
  const prefix = `${path.basename(state)}.engine-`;
  let names = [];
  try {
    names = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of names) {
    if (!name.startsWith(prefix) || !name.endsWith('.json')) continue;
    const pid = Number(name.slice(prefix.length, -'.json'.length));
    if (!Number.isInteger(pid) || !alive(pid)) continue;
    try {
      const s = JSON.parse(readFileSync(path.join(dir, name), 'utf8'));
      if (Number(s.memMiB) > 0) out.set(pid, { memMiB: Number(s.memMiB), sharedMiB: Number(s.sharedMiB) || 0 });
    } catch {
      // Being rewritten: the next reading has it.
    }
  }
  return out;
}

process.stdout.on('error', () => process.exit(0));
const named = new Set();
const reading = () => {
  if (!alive(parent)) process.exit(0);
  const now = engines();
  let line = 'S';
  for (const [pid, m] of now) {
    if (!named.has(pid)) {
      named.add(pid);
      process.stdout.write(`N ${pid} llama-server\n`);
    }
    line += ` ${pid}=${Math.round(m.memMiB * MIB)}/${Math.round(m.sharedMiB * MIB)}`;
  }
  process.stdout.write(`${line}\n`);
};
// The first reading at once, like the real monitor (the core waits for it), then one per interval.
reading();
setInterval(reading, intervalMs);
