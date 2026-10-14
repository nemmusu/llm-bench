/**
 * NInfer in WSL end to end, with real processes: the fake wsl.exe runs the fake ninfer-serve as the
 * distro's program. Detect (probe + commit), plan (path mapping), start (Linux PID recorded), a chat
 * request measured by the chat client, stop (only our PID, after the environment check).
 */
import { afterAll, describe, expect, it } from 'vitest';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { launchParamsSchema } from '../../../../../src/contract/engines';
import { NinferAdapter, type NinferLaunchPlan } from '../../../../../src/core/engines/ninfer/adapter';
import { WslProcesses } from '../../../../../src/core/engines/ninfer/wsl';
import type { StreamEvent } from '../../../../../src/core/inference/types';
import { systemClock } from '../../../../../src/core/node-deps';
import { pickFreePort } from '../../../../../src/core/process/ports';
import { silentLog, tempDir } from '../../docker/helpers';
import { ninferModel, realClients, realProc, WSL_ARGV } from './helpers';

const cleanups: (() => void)[] = [];
afterAll(() => {
  for (const c of cleanups) c();
});
const tmp = () => {
  const t = tempDir('gb-ninfer-wsl-');
  cleanups.push(t.cleanup);
  return t.dir;
};

function setup() {
  const root = tmp();
  const proc = realProc(path.join(root, 'wsl'));
  const processes = new WslProcesses({ proc, wsl: WSL_ARGV, file: path.join(root, 'ninfer-wsl.json'), sleep: (ms) => systemClock.sleep(ms), graceMs: 3000 });
  const adapter = new NinferAdapter({
    kind: 'ninfer-wsl',
    deps: { clock: systemClock, proc, fetch: globalThis.fetch, platform: 'win32', log: silentLog },
    createClient: realClients,
    saved: async () => ({ wsl: { distro: 'Ubuntu-24.04', path: '/home/user/ninfer' } }),
    gpus: async () => [{ name: 'NVIDIA GeForce RTX 5090', computeCapability: '12.0', memTotalMiB: 32607 }],
    wsl: { argv: WSL_ARGV, processes },
    pollMs: 50,
    readyTimeoutMs: 30_000,
  });
  return { root, proc, processes, adapter };
}

describe('NInfer in WSL (fake wsl.exe, real processes)', () => {
  it('detects the build, its commit and the distro', async () => {
    const { adapter } = setup();
    expect(await adapter.detect()).toEqual({
      kind: 'ninfer-wsl',
      available: true,
      installed: true,
      location: '/home/user/ninfer/build/apps/ninfer-serve',
      variant: 'Ubuntu-24.04',
      version: 'e31bc99b13f5',
      problems: [],
      supported: true,
    });
    const caps = await adapter.capabilities({ kind: 'ninfer-wsl' });
    expect(caps.flags.has('--kv-dtype')).toBe(true);
    expect(caps).toMatchObject({ version: 'e31bc99b13f5', tokenIdsInPrompt: false, timings: true });
    // A path that is not a build, a distro that does not exist.
    expect(await adapter.check({ kind: 'ninfer-wsl', ninferPath: '/opt/nothing' })).toMatchObject({ available: false, installed: false, problems: ['ENGINE_NOT_INSTALLED'], problemParams: { reason: 'ninfer_not_found' } });
    expect(await adapter.check({ kind: 'ninfer-wsl', wslDistro: 'Debian' })).toMatchObject({ problems: ['ENGINE_NOT_INSTALLED'], problemParams: { reason: 'distro_missing', distro: 'Debian' } });
  }, 60_000);

  it('starts ninfer-serve in the distro, serves a chat request, and stops only its own process', async () => {
    const { root, adapter, processes } = setup();
    const model = ninferModel(path.join(root, 'models'));
    const port = await pickFreePort();
    const params = launchParamsSchema.parse({ contextSize: 4096, ninfer: { kvDtype: 'int8', spec: 'mtp', prefixReuse: false, thinking: false } });
    const plan = (await adapter.plan({ kind: 'ninfer-wsl' }, model, params, { port, marker: 'gpubench-wsl-1' })) as NinferLaunchPlan;
    const windowsFile = model.local.paths[0] as string;
    const linuxFile = process.platform === 'win32' ? `/mnt/${windowsFile[0]?.toLowerCase()}/${windowsFile.slice(3).replace(/\\/g, '/')}` : windowsFile;
    expect(plan.argv.slice(2, 10)).toEqual(['-d', 'Ubuntu-24.04', '--exec', '/usr/bin/env', 'GPUBENCH_OWNER=gpubench-wsl-1', '/bin/sh', '-c', 'echo "gpubench-pid $$" >&2; exec "$@"']);
    expect(plan.argv.slice(10, 13)).toEqual(['sh', '/home/user/ninfer/build/apps/ninfer-serve', linuxFile]);
    // Only a model on a Windows drive (/mnt/c…) is read slowly from WSL.
    expect(plan.slowSharedFilesystem).toBe(process.platform === 'win32' ? true : undefined);
    const inst = await adapter.start(plan, new AbortController().signal);
    expect(inst.pid).toBeUndefined();
    const ready = await inst.waitReady();
    expect(ready.phases.map((p) => p.name)).toEqual(['weights', 'cuda-graphs', 'engine-ready', 'listening']);
    const recs = await processes.list();
    expect(recs).toHaveLength(1);
    expect(recs[0]).toMatchObject({ distro: 'Ubuntu-24.04', marker: 'gpubench-wsl-1' });
    const events: StreamEvent[] = [];
    for await (const e of inst.client.generate({ promptText: 'x'.repeat(400), outputTokens: 8, seed: 1 })) events.push(e);
    expect(events.at(-1)).toMatchObject({ kind: 'done', usage: { completionTokens: 8 }, finishReason: 'length' });
    expect(inst.logTail().some((l) => l.includes('capacity | KV 4,096 tokens, int8'))).toBe(true);
    expect(inst.logTail().some((l) => l.startsWith('gpubench-pid'))).toBe(false);
    // Someone else's process in the distro is never signalled: a wrong marker is refused.
    expect(await processes.stop({ distro: 'Ubuntu-24.04', pid: recs[0]?.pid as number, marker: 'gpubench-someone-else' })).toBe(false);
    await inst.stop();
    expect(await processes.list()).toEqual([]);
    expect(await processes.owned('Ubuntu-24.04', recs[0]?.pid as number, 'gpubench-wsl-1')).toBe(false);
    expect(readFileSync(path.join(root, 'ninfer-wsl.json'), 'utf8')).toContain('"records": []');
  }, 60_000);

  it('a launch that does not fit fails with the capacity that would have fit', async () => {
    const { root, adapter } = setup();
    const model = ninferModel(path.join(root, 'models'));
    const params = launchParamsSchema.parse({ contextSize: 262_144, ninfer: { kvDtype: 'bf16', spec: 'mtp', prefixReuse: false } });
    const plan = await adapter.plan({ kind: 'ninfer-wsl' }, model, params, { port: await pickFreePort(), marker: 'gpubench-wsl-2' });
    const inst = await adapter.start(plan, new AbortController().signal);
    await expect(inst.waitReady()).rejects.toMatchObject({ code: 'ENGINE_OOM', params: { reason: 'ninfer-reservation', estimatedMaxModelLen: expect.any(Number) } });
  }, 60_000);
});
