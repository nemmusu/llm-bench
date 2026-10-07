/**
 * Windows only, real processes: the GPU-counter monitor (Windows PowerShell 5.1) spawned through the
 * real ProcessRunner, reading the real counters, while a short-lived node child that never touches the
 * GPU is "the engine". Proves the script runs on this Windows (English counter names on any locale),
 * that a process without GPU memory is reported as not attributable, and that dispose() ends OUR child.
 * Needs no GPU workload: the desktop (dwm) always holds dedicated memory on a WDDM machine.
 */
import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { systemClock } from '../../../../src/core/node-deps';
import { createProcessRunner } from '../../../../src/core/process/runner';
import { ProcessVramRecorder, WindowsGpuMemory } from '../../../../src/core/telemetry/process-vram';

const isWindows = process.platform === 'win32';

describe.runIf(isWindows)('Windows GPU counters, real monitor', () => {
  it('lists the desktop, attributes nothing to a process without GPU memory, and stops its child', async () => {
    const proc = createProcessRunner({ clock: systemClock, platform: 'win32', baseEnv: process.env });
    const spawned: number[] = [];
    const tracking = {
      run: proc.run,
      spawn: (spec: Parameters<typeof proc.spawn>[0]) => {
        const p = proc.spawn(spec);
        spawned.push(p.pid);
        return p;
      },
    };
    const mem = new WindowsGpuMemory({ proc: tracking, clock: systemClock, env: process.env, intervalMs: 500 });
    const engine = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 15000)'], { windowsHide: true, stdio: 'ignore' });
    try {
      // The first reads of the counters can miss their window on a busy PC (several test runs at once):
      // retry with a pause, as the recorder keeps retrying too.
      let all = await mem.read();
      for (let i = 0; i < 10 && all === undefined; i++) {
        await new Promise((r) => setTimeout(r, 500));
        all = await mem.read();
      }
      expect(all, 'the GPU Process Memory counters should be readable').toBeDefined();
      expect(all!.length).toBeGreaterThan(0);
      expect(all!.every((p) => Number.isInteger(p.pid) && p.mib > 0)).toBe(true);
      expect(all!.some((p) => p.name !== undefined)).toBe(true);
      expect(all!.some((p) => p.pid === engine.pid)).toBe(false);

      const rec = new ProcessVramRecorder({ source: mem, clock: systemClock, pids: [engine.pid!], intervalMs: 500 });
      await rec.ready;
      await new Promise((r) => setTimeout(r, 1200));
      const ticks = await rec.stop();
      expect(ticks.length).toBeGreaterThanOrEqual(2);
      expect(ticks.every((t) => t.engine[0] === engine.pid && t.engineMiB === 0)).toBe(true);
      expect(rec.peakMiB()).toBeUndefined();
      expect(rec.latestMiB()).toBeUndefined();
    } finally {
      engine.kill();
      await mem.dispose();
    }
    expect(mem.running).toBe(false);
    expect(spawned).toHaveLength(1);
    // Our monitor child is gone (and only it was ever stopped).
    await new Promise((r) => setTimeout(r, 300));
    expect(() => process.kill(spawned[0]!, 0)).toThrow();
  }, 60_000);
});
