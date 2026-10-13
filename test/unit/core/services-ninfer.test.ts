import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import type { StartRunRequest } from '../../../src/contract/api';
import type { LocalModel } from '../../../src/contract/models';
import type { ProcessRunner } from '../../../src/core/deps';
import { createServices, modelsLookup, resolveModelTarget, serviceModules } from '../../../src/core/services';
import { createApp } from '../../../src/core/server/app';
import { recordingLog } from './docker/helpers';
import { tempDir, testContext, testDeps } from './server/helpers';

const base: Omit<StartRunRequest, 'engine' | 'model'> = { profile: 'quick', allowSharedGpu: false };

const artifact = (over: Partial<LocalModel> = {}): LocalModel => ({
  id: 'n1',
  identity: { displayName: 'qwen3_8_27b_nvfp4', format: 'ninfer', source: 'hf', repo: 'neroued/Qwen3.8-27B-nvfp4-NInfer', file: 'qwen3_8_27b_nvfp4.ninfer', files: ['qwen3_8_27b_nvfp4.ninfer'], weakKey: 'w' },
  paths: ['/m/qwen3_8_27b_nvfp4.ninfer'],
  auxiliary: [],
  dir: '/m',
  origin: 'library',
  modifiedAt: '2026-01-01T00:00:00Z',
  ...over,
});

describe('NInfer models of the library', () => {
  it('finds the downloaded copy of a hub .ninfer artifact', async () => {
    const lib = artifact();
    const lookup = modelsLookup({ models: { list: async () => [artifact({ id: 'x', incomplete: { missing: ['a'] } as never }), lib] } as never });
    expect(await lookup.findNinfer?.('neroued/Qwen3.8-27B-nvfp4-NInfer', 'sub/qwen3_8_27b_nvfp4.ninfer')).toBe(lib);
    expect(await lookup.findNinfer?.('neroued/other', 'qwen3_8_27b_nvfp4.ninfer')).toBeUndefined();
    expect(await modelsLookup({ models: { list: () => Promise.reject(new Error('scan')) } as never }).findNinfer?.('r', 'f.ninfer')).toBeUndefined();
  });

  it('runs a hub artifact only once it is downloaded (there is no preview of one)', async () => {
    const lib = artifact();
    const req = { ...base, engine: { kind: 'ninfer-wsl' as const }, model: { repo: 'neroued/Qwen3.8-27B-nvfp4-NInfer', file: 'qwen3_8_27b_nvfp4.ninfer' } };
    expect(await resolveModelTarget(req, { getLocal: async () => undefined, findNinfer: async () => lib })).toEqual({ identity: lib.identity, local: lib });
    const notYet = { code: 'MODEL_NOT_FOUND', params: { reason: 'not_downloaded', repo: req.model.repo, file: req.model.file } };
    await expect(resolveModelTarget(req, { getLocal: async () => undefined, findNinfer: async () => undefined }, { preview: true })).rejects.toMatchObject(notYet);
    await expect(resolveModelTarget(req, undefined)).rejects.toMatchObject(notYet);
  });
});

describe('NInfer in the services', () => {
  let t: ReturnType<typeof tempDir>;
  beforeEach(() => {
    t = tempDir();
  });
  afterEach(() => t.cleanup());

  const quietProc: ProcessRunner = {
    run: () => Promise.resolve({ code: 1, stdout: '', stderr: '', timedOut: false }),
    spawn: () => {
      throw new Error('no spawn');
    },
  };

  it('reads the GPUs for the RTX 5090 check, the library for updates, and serves its routes', async () => {
    for (const modelServices of [false, undefined] as const) {
      const log = recordingLog();
      // A data folder where the WSL records cannot be written: the cleanup failure is only logged.
      mkdirSync(path.join(t.dir, 'ninfer-wsl.json'), { recursive: true });
      const ctx = testContext(testDeps(t.dir, { platform: 'win32', proc: quietProc, log }));
      ctx.telemetry.probe = async () => [{ index: 0, name: 'NVIDIA GeForce RTX 4090', memoryTotalMiB: 24_564, computeCapability: '8.9' }] as never;
      await ctx.settings.update({ ninfer: { wsl: { distro: 'Ubuntu', path: '/home/u/ninfer' } } });
      const s = await createServices(ctx, { ...(modelServices === false ? { modelServices: false } : {}) });
      expect(await s.ninfer.wsl.detect()).toMatchObject({ problems: ['ENGINE_NOT_INSTALLED'] });
      expect(await s.ninfer.native.detect()).toMatchObject({ supported: false });
      ctx.telemetry.probe = async () => [{ index: 0, name: 'NVIDIA GeForce RTX 4090', memoryTotalMiB: 24_564 }] as never;
      s.ninfer.wsl.forget();
      expect((await s.ninfer.wsl.check({ kind: 'ninfer-wsl' })).problems).toEqual(['ENGINE_NOT_INSTALLED']);
      // Its "Aggiorna" is the engines' own: the label, the check (nothing answers here: no git).
      expect(await s.updates.labelOf('ninfer-wsl')).toBe('NInfer (WSL)');
      expect(await s.updates.labelOf('ninfer-native')).toBe('NInfer');
      expect(await s.updates.check('ninfer-wsl')).toMatchObject({ target: 'ninfer-wsl', state: 'none', reason: 'tools', ninfer: { artifacts: [] } });
      const app = createApp(ctx, { token: 't', port: () => 1, modules: serviceModules(s) });
      const res = await app.request('/api/engines/ninfer/distros', { headers: { authorization: 'Bearer t', host: '127.0.0.1:1' } });
      expect(await res.json()).toEqual({ wsl: false, distros: [] });
      await expect.poll(() => log.entries.some((e) => e.msg === 'NInfer WSL cleanup failed'), { timeout: 10_000 }).toBe(true);
      // A guided build through the app: its events go to the hub (here it stops at once: no Linux to ask).
      const events: unknown[] = [];
      ctx.hub.subscribe((e) => events.push(e));
      const build = await app.request('/api/engines/ninfer/build', { method: 'POST', body: JSON.stringify({ kind: 'ninfer-wsl', distro: 'Ubuntu', confirm: true }), headers: { authorization: 'Bearer t', host: '127.0.0.1:1', 'content-type': 'application/json' } });
      expect(build.status).toBe(200);
      await expect.poll(() => events.some((e) => (e as { stage?: string }).stage === 'error')).toBe(true);
      // Telemetry that cannot answer: no GPU to judge.
      ctx.telemetry.probe = () => Promise.reject(new Error('nvml'));
      s.ninfer.wsl.forget();
      expect((await s.ninfer.wsl.detect()).problems).not.toContain('ENGINE_GPU_UNSUPPORTED');
    }
  });
});
