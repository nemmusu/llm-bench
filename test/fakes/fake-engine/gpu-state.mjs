// Shared fake-nvidia-smi state (env FAKE_NVIDIA_SMI_STATE): JSON {"gpus":[{memUsedMiB, utilPct, powerW, ...}]}.
// The fake engine only read-modify-writes gpus[0] (never deletes fields). What it added is
// tracked in a sidecar file so the contribution can be removed exactly once, either by the
// engine itself on a clean exit or by a detached watchdog when the engine is killed hard
// (Windows taskkill /F and SIGKILL run no exit handlers).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const RETRYABLE = new Set(['EPERM', 'EACCES', 'EBUSY']);

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Read-modify-write of gpus[0]. Writes go through a temp file + rename so the fake nvidia-smi
 * never reads half a file; Windows may refuse the rename while the reader has it open.
 * @param {string} file
 * @param {(gpu: Record<string, any>) => void} fn
 */
export function updateGpu0(file, fn) {
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      const json = JSON.parse(fs.readFileSync(file, 'utf8'));
      const gpu = Array.isArray(json.gpus) ? json.gpus[0] : undefined;
      if (!gpu || typeof gpu !== 'object') return;
      fn(gpu);
      const tmp = `${file}.${process.pid}.${attempt}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(json, null, 2));
      try {
        fs.renameSync(tmp, file);
      } catch (e) {
        fs.rmSync(tmp, { force: true });
        throw e;
      }
      return;
    } catch (e) {
      const code = /** @type {NodeJS.ErrnoException} */ (e).code;
      if (code === 'ENOENT') return;
      if (!RETRYABLE.has(code ?? '') && !(e instanceof SyntaxError)) throw e;
      sleepSync(10 + attempt * 5);
    }
  }
}

/**
 * Release a contribution recorded in `sidecar`. Claiming = deleting the sidecar, so the engine
 * and the watchdog can race safely: only the one that deletes it applies the change.
 * @param {string} file
 * @param {string} sidecar
 */
export function releaseContribution(file, sidecar) {
  let applied;
  try {
    applied = JSON.parse(fs.readFileSync(sidecar, 'utf8'));
    fs.unlinkSync(sidecar);
  } catch {
    return false;
  }
  updateGpu0(file, (g) => {
    g.memUsedMiB = Math.max(0, (Number(g.memUsedMiB) || 0) - (applied.memMiB || 0));
    if (applied.busy) {
      g.utilPct = applied.idle.utilPct;
      g.powerW = applied.idle.powerW;
    }
  });
  return true;
}

export class GpuState {
  /**
   * @param {string | undefined} file
   * @param {{ watchdog?: boolean }} [opts]
   */
  constructor(file, opts = {}) {
    this.file = file;
    this.sidecar = file ? `${file}.engine-${process.pid}.json` : undefined;
    this.memMiB = 0;
    /** Shared GPU memory of this engine (the Windows counters' Shared Usage), read by fake-gpu-memory.mjs. */
    this.sharedMiB = 0;
    this.busy = false;
    this.idle = { utilPct: 0, powerW: 30 };
    if (!file) return;
    updateGpu0(file, (g) => {
      this.idle = { utilPct: Number(g.utilPct ?? 0), powerW: Number(g.powerW ?? 30) };
    });
    this.save();
    if (opts.watchdog !== false) startWatchdog(file, /** @type {string} */ (this.sidecar));
  }

  save() {
    if (!this.sidecar) return;
    fs.writeFileSync(this.sidecar, JSON.stringify({ memMiB: this.memMiB, sharedMiB: this.sharedMiB, busy: this.busy, idle: this.idle }));
  }

  /** This engine's shared GPU memory becomes `mib` (only in its sidecar: nvidia-smi never reports it). */
  setShared(mib) {
    if (!this.file || this.sharedMiB === mib) return;
    this.sharedMiB = mib;
    this.save();
  }

  /** Our VRAM contribution becomes `mib` (the delta is applied to whatever else is there). */
  setMem(mib) {
    if (!this.file) return;
    const delta = mib - this.memMiB;
    this.memMiB = mib;
    updateGpu0(this.file, (g) => {
      g.memUsedMiB = Math.max(0, (Number(g.memUsedMiB) || 0) + delta);
    });
    this.save();
  }

  /** @param {{ utilPct: number, powerW: number, tempC?: number } | null} load null = back to idle */
  setLoad(load) {
    if (!this.file) return;
    this.busy = load !== null;
    updateGpu0(this.file, (g) => {
      g.utilPct = load ? load.utilPct : this.idle.utilPct;
      g.powerW = load ? load.powerW : this.idle.powerW;
      if (load?.tempC !== undefined) g.tempC = load.tempC;
    });
    this.save();
  }

  release() {
    if (!this.file || !this.sidecar) return;
    releaseContribution(this.file, this.sidecar);
  }
}

/** Detached grandchild (double spawn) so `taskkill /T` / process-group kills of the engine miss it. */
function startWatchdog(file, sidecar) {
  const script = fileURLToPath(new URL('./watchdog.mjs', import.meta.url));
  const child = spawn(process.execPath, [script, '--launch', String(process.pid), file, sidecar], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
}
