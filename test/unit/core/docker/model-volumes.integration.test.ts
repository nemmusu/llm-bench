// ModelVolumes through the REAL ProcessRunner and the fake docker CLI (test/fakes/fake-docker),
// whose busybox helper really copies the files into the volume's folder and measures it with du.
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { LocalModel } from '../../../../src/contract/models';
import type { Platform } from '../../../../src/core/deps';
import { DockerCli } from '../../../../src/core/docker/cli';
import { HELPER_IMAGE, ModelVolumes, parseDuBytes, type CopyProgress } from '../../../../src/core/docker/model-volumes';
import { systemClock } from '../../../../src/core/node-deps';
import { createProcessRunner } from '../../../../src/core/process/runner';
import { FAKE_DOCKER, tempDir } from './helpers';

const platform = process.platform as Platform;
const cleanups: (() => void)[] = [];
afterAll(() => {
  for (const c of cleanups) c();
});

function setup(env: Record<string, string> = {}) {
  const t = tempDir('gb-mvol-');
  cleanups.push(t.cleanup);
  const state = path.join(t.dir, 'state');
  const models = path.join(t.dir, 'models');
  mkdirSync(models, { recursive: true });
  const shards = ['demo-Q4_K_M-00001-of-00002.gguf', 'demo-Q4_K_M-00002-of-00002.gguf'].map((n) => path.join(models, n));
  writeFileSync(shards[0] as string, Buffer.alloc(3000, 1));
  writeFileSync(shards[1] as string, Buffer.alloc(2000, 2));
  const mmproj = path.join(models, 'mmproj-F16.gguf');
  writeFileSync(mmproj, Buffer.alloc(500, 3));
  const baseEnv = { ...process.env, FAKE_DOCKER_STATE: state, ...env };
  const proc = createProcessRunner({ clock: systemClock, platform, baseEnv });
  const cli = new DockerCli({ proc, platform, env: baseEnv, override: [process.execPath, FAKE_DOCKER] });
  const pulls: string[] = [];
  // The helper image is pulled through the CLI here (the Engine API is not part of this test).
  const images = {
    pull: async (ref: string) => {
      pulls.push(ref);
      await cli.exec(['pull', ref]);
      return {};
    },
  };
  const identity = { displayName: 'demo-Q4_K_M', format: 'gguf' as const, source: 'local' as const, files: [], weakKey: 'demo', sizeBytes: 5000 };
  const model: LocalModel = {
    id: 'abc123',
    identity,
    paths: [...shards, mmproj],
    auxiliary: [{ kind: 'mmproj', path: mmproj }],
    dir: models,
    origin: 'library',
    modifiedAt: '',
  };
  return { state, cli, images, pulls, model, shards };
}

describe.skipIf(!existsSync(FAKE_DOCKER))('ModelVolumes with the fake docker CLI', () => {
  it('copies the weights into a labelled volume, lists, finds, measures and removes it', async () => {
    const s = setup({ FAKE_DOCKER_COPY_MS: '60' });
    const volumes = new ModelVolumes({ cli: s.cli, images: s.images, clock: systemClock, pollMs: 20 });
    expect(await volumes.list()).toEqual([]);
    expect(await volumes.exists('abc123')).toBe(false);

    const progress: CopyProgress[] = [];
    const name = await volumes.copy(s.model, (p) => progress.push(p), new AbortController().signal);
    expect(name).toBe('gpubench-model-abc123');
    // busybox is present like any image: nothing to pull.
    expect(s.pulls).toEqual([]);
    expect(progress[0]).toEqual({ bytesDone: 0, bytesTotal: 5000 });
    expect(progress.at(-1)).toEqual({ bytesDone: 5000, bytesTotal: 5000 });
    for (const [i, p] of progress.entries()) {
      expect(p.bytesDone).toBeLessThanOrEqual(5000);
      if (i > 0) expect(p.bytesDone).toBeGreaterThanOrEqual((progress[i - 1] as CopyProgress).bytesDone);
    }

    // Weights only, at the volume's root (the mmproj stays out).
    expect(readdirSync(path.join(s.state, 'volumes', name)).sort()).toEqual(['demo-Q4_K_M-00001-of-00002.gguf', 'demo-Q4_K_M-00002-of-00002.gguf']);
    expect(await volumes.exists('abc123')).toBe(true);
    expect(await volumes.list()).toEqual(['abc123']);
    const inspect = await s.cli.exec(['volume', 'inspect', name]);
    expect(JSON.parse(inspect.stdout)[0]).toMatchObject({ Name: name, Labels: { gpubench: '1', 'gpubench.model': 'abc123' } });
    const du = await s.cli.exec(['run', '--rm', '-v', `${name}:/dst:ro`, HELPER_IMAGE, 'du', '-sb', '/dst']);
    expect(du.code).toBe(0);
    expect(parseDuBytes(du.stdout)).toBe(5000);

    // Volumes that are not model copies (no gpubench.model label) are never listed.
    expect((await s.cli.exec(['volume', 'create', 'someone-else'])).stdout.trim()).toBe('someone-else');
    expect(await volumes.list()).toEqual(['abc123']);
    expect((await s.cli.exec(['volume', 'ls', '-q'])).stdout.split(/\r?\n/).filter(Boolean).sort()).toEqual([name, 'someone-else']);

    await volumes.remove('abc123');
    expect(await volumes.exists('abc123')).toBe(false);
    expect(existsSync(path.join(s.state, 'volumes', name))).toBe(false);
    // Already gone: `rm -f` succeeds; without -f the daemon complains.
    await expect(volumes.remove('abc123')).resolves.toBeUndefined();
    expect((await s.cli.exec(['volume', 'rm', name])).stderr).toContain('no such volume');
  });

  it('pulls a missing helper image first, and drops the volume when the copy fails', async () => {
    const s = setup({ FAKE_DOCKER_MISSING: HELPER_IMAGE });
    // A size for a file that is not there: the copy inside the container fails.
    const gone = path.join(path.dirname(s.shards[0] as string), 'vanished.gguf');
    const volumes = new ModelVolumes({ cli: s.cli, images: s.images, clock: systemClock, pollMs: 20, stat: async () => ({ size: 10 }) });
    const broken: LocalModel = { ...s.model, id: 'gone1', paths: [gone], auxiliary: [] };
    await expect(volumes.copy(broken, () => {}, new AbortController().signal)).rejects.toMatchObject({ code: 'DOCKER_VOLUME_FAILED', params: { code: 1 } });
    expect(s.pulls).toEqual([HELPER_IMAGE]);
    expect(await volumes.exists('gone1')).toBe(false);
    // The pulled helper is kept: the next copy needs no pull.
    await volumes.copy(s.model, () => {}, new AbortController().signal);
    expect(s.pulls).toEqual([HELPER_IMAGE]);
    expect(await volumes.list()).toEqual(['abc123']);
  });

  it('a cancelled copy stops the helper container and removes the partial volume', async () => {
    const s = setup({ FAKE_DOCKER_COPY_MS: '10000' });
    const volumes = new ModelVolumes({ cli: s.cli, images: s.images, clock: systemClock, pollMs: 20 });
    const ac = new AbortController();
    const progress: CopyProgress[] = [];
    const copying = volumes.copy(s.model, (p) => {
      progress.push(p);
      // The first shard is in the volume (seen by du): cancel while the helper pauses.
      if (p.bytesDone === 3000) ac.abort();
    }, ac.signal);
    await expect(copying).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(progress.some((p) => p.bytesDone === 3000)).toBe(true);
    expect(await volumes.exists('abc123')).toBe(false);
    expect(existsSync(path.join(s.state, 'volumes', 'gpubench-model-abc123'))).toBe(false);
  });
});
