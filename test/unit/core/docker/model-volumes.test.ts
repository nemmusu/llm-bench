import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { ServerEvent } from '../../../../src/contract/events';
import type { LocalModel } from '../../../../src/contract/models';
import type { CoreContext } from '../../../../src/core/context';
import type { DockerCli } from '../../../../src/core/docker/cli';
import { createModelVolumeRoutes } from '../../../../src/core/docker/model-volume-routes';
import { HELPER_IMAGE, ModelVolumes, modelVolumeName, parseDuBytes } from '../../../../src/core/docker/model-volumes';
import type { Clock, ExitInfo, ManagedProcess, RunOutput } from '../../../../src/core/deps';
import { errorResponse } from '../../../../src/core/server/http-error';

const model: LocalModel = {
  id: 'abc123',
  identity: { displayName: 'Qwen3 4B', format: 'gguf', source: 'local', files: [], weakKey: 'k' },
  paths: ['C:\\models\\q\\Qwen3-4B-Q4_K_M.gguf', 'C:\\models\\q\\mmproj.gguf'],
  auxiliary: [{ kind: 'mmproj', path: 'C:\\models\\q\\mmproj.gguf' }],
  dir: 'C:\\models\\q',
  origin: 'library',
  modifiedAt: '2026-01-01T00:00:00Z',
};

const clock: Clock = { now: () => 0, wall: () => 0, sleep: () => new Promise((r) => setTimeout(r, 1)) };

interface FakeCli {
  calls: string[][];
  spawned: string[][];
  cli: DockerCli;
  finishCopy(code: number | null): void;
}

function fakeCli(o: { volumes?: string; inspectCode?: number; createCode?: number; helper?: boolean; du?: string[]; duCode?: number; lsCode?: number; rmCode?: number } = {}): FakeCli {
  const calls: string[][] = [];
  const spawned: string[][] = [];
  let finish!: (e: ExitInfo) => void;
  const exited = new Promise<ExitInfo>((r) => (finish = r));
  const du = [...(o.du ?? ['0\t/dst'])];
  const out = (code: number, stdout = ''): RunOutput => ({ code, stdout, stderr: code ? 'boom' : '', timedOut: false });
  const cli = {
    exec: async (args: readonly string[]) => {
      calls.push([...args]);
      if (args[0] === 'volume' && args[1] === 'ls') return out(o.lsCode ?? 0, o.volumes ?? '');
      if (args[0] === 'volume' && args[1] === 'inspect') return out(o.inspectCode ?? 0);
      if (args[0] === 'volume' && args[1] === 'create') return out(o.createCode ?? 0);
      if (args[0] === 'volume' && args[1] === 'rm') return out(o.rmCode ?? 0);
      if (args.includes('du')) return out(o.duCode ?? 0, du.shift() ?? 'garbage');
      return out(0);
    },
    imageInspect: async () => (o.helper === false ? undefined : ({ id: 'x' } as never)),
    spawn: async (args: readonly string[]) => {
      spawned.push([...args]);
      return { pid: 1, startedAt: 0, lines: (async function* () {})(), exited, stop: async () => {
        finish({ code: null, signal: 'SIGKILL' });
        return { code: null, signal: 'SIGKILL' };
      } } satisfies ManagedProcess;
    },
  } as unknown as DockerCli;
  return { calls, spawned, cli, finishCopy: (code) => finish({ code, signal: null }) };
}

describe('model volume helpers', () => {
  it('names volumes safely and parses du', () => {
    expect(modelVolumeName('abc123')).toBe('gpubench-model-abc123');
    expect(() => modelVolumeName('../evil')).toThrow();
    expect(parseDuBytes('2497280256\t/dst\n')).toBe(2497280256);
    expect(parseDuBytes('')).toBeUndefined();
    expect(parseDuBytes('nope')).toBeUndefined();
  });
});

describe('ModelVolumes', () => {
  it('lists our model volumes and checks one', async () => {
    const f = fakeCli({ volumes: 'gpubench-model-abc123\nother-volume\n\ngpubench-model-def\n' });
    const v = new ModelVolumes({ cli: f.cli, images: { pull: async () => ({}) }, clock });
    expect(await v.list()).toEqual(['abc123', 'def']);
    expect(await v.exists('abc123')).toBe(true);
    const missing = new ModelVolumes({ cli: fakeCli({ inspectCode: 1, lsCode: 1 }).cli, images: { pull: async () => ({}) }, clock });
    expect(await missing.exists('abc123')).toBe(false);
    expect(await missing.list()).toEqual([]);
  });

  it('copies the weights (not auxiliaries) with explicit cp arguments and reports progress', async () => {
    const f = fakeCli({ helper: false, du: ['1000\t/dst', 'x'] });
    let pulled = '';
    const v = new ModelVolumes({
      cli: f.cli,
      images: {
        pull: async (ref, onProgress) => {
          onProgress({ bytesDone: 1, bytesTotal: 1, layersDone: 1, layersTotal: 1, status: 'done' } as never);
          pulled = ref;
          return {};
        },
      },
      clock,
      pollMs: 1,
      stat: async () => ({ size: 4000 }),
    });
    const progress: number[] = [];
    const p = v.copy(model, (x) => progress.push(x.bytesDone), new AbortController().signal);
    // At least one poll of the copied size before the copy ends (a fixed delay is flaky on a busy machine).
    await vi.waitFor(() => expect(progress).toContain(1000));
    f.finishCopy(0);
    expect(await p).toBe('gpubench-model-abc123');
    expect(pulled).toBe(HELPER_IMAGE);
    expect(f.spawned[0]).toEqual([
      'run', '--rm', '--label', 'gpubench=1', '-v', 'C:\\models\\q:/src:ro', '-v', 'gpubench-model-abc123:/dst', HELPER_IMAGE, 'cp', '/src/Qwen3-4B-Q4_K_M.gguf', '/dst/',
    ]);
    expect(progress[0]).toBe(0);
    expect(progress).toContain(1000);
    expect(progress.at(-1)).toBe(4000);
    expect(f.calls.find((c) => c[1] === 'create')).toContain('gpubench.model=abc123');
  });

  it('cleans up after a failed or cancelled copy, and reports volume errors', async () => {
    const failed = fakeCli();
    const v = new ModelVolumes({ cli: failed.cli, images: { pull: async () => ({}) }, clock, pollMs: 1, stat: async () => ({ size: 10 }) });
    const p = v.copy(model, () => {}, new AbortController().signal);
    await new Promise((r) => setTimeout(r, 5));
    failed.finishCopy(1);
    await expect(p).rejects.toMatchObject({ code: 'DOCKER_VOLUME_FAILED', params: { code: 1 } });
    expect(failed.calls.some((c) => c[1] === 'rm')).toBe(true);

    // Killed from outside (no exit code), with du failing meanwhile.
    const killed = fakeCli({ duCode: 1 });
    const vk = new ModelVolumes({ cli: killed.cli, images: { pull: async () => ({}) }, clock, pollMs: 1, stat: async () => ({ size: 10 }) });
    const pk = vk.copy(model, () => {}, new AbortController().signal);
    await new Promise((r) => setTimeout(r, 10));
    killed.finishCopy(null);
    await expect(pk).rejects.toMatchObject({ code: 'DOCKER_VOLUME_FAILED', params: { code: -1 } });

    const cancelled = fakeCli();
    const v2 = new ModelVolumes({ cli: cancelled.cli, images: { pull: async () => ({}) }, clock, stat: async () => ({ size: 10 }) });
    const ac = new AbortController();
    const p2 = v2.copy(model, () => {}, ac.signal);
    await new Promise((r) => setTimeout(r, 5));
    ac.abort();
    await expect(p2).rejects.toMatchObject({ code: 'CANCELLED' });

    const noCreate = new ModelVolumes({ cli: fakeCli({ createCode: 1 }).cli, images: { pull: async () => ({}) }, clock, stat: async () => ({ size: 1 }) });
    await expect(noCreate.copy(model, () => {}, new AbortController().signal)).rejects.toMatchObject({ code: 'DOCKER_VOLUME_FAILED' });
    await expect(v.copy({ ...model, paths: [] }, () => {}, new AbortController().signal)).rejects.toMatchObject({ code: 'MODEL_NOT_FOUND' });

    await expect(new ModelVolumes({ cli: fakeCli().cli, images: { pull: async () => ({}) }, clock }).remove('abc123')).resolves.toBeUndefined();
    await expect(new ModelVolumes({ cli: fakeCli({ rmCode: 1 }).cli, images: { pull: async () => ({}) }, clock }).remove('abc123')).rejects.toMatchObject({
      code: 'DOCKER_VOLUME_FAILED',
    });
  });

  it('uses fs.stat by default', async () => {
    const v = new ModelVolumes({ cli: fakeCli().cli, images: { pull: async () => ({}) }, clock });
    await expect(v.copy({ ...model, paths: ['Z:\\nope\\missing.gguf'] }, () => {}, new AbortController().signal)).rejects.toThrow();
  });
});

describe('model volume routes', () => {
  function app(volumes: ModelVolumes, getLocal: (id: string) => Promise<LocalModel | undefined>) {
    const events: ServerEvent[] = [];
    const a = new Hono();
    a.onError((e, c) => errorResponse(c, e));
    const shutdown = new AbortController();
    createModelVolumeRoutes({ volumes, getLocal, publish: (e) => events.push(e), shutdown: shutdown.signal })(a, {} as CoreContext);
    return { a, events, shutdown };
  }

  it('lists, copies with progress events, refuses a second copy, and deletes', async () => {
    let finish!: () => void;
    const volumes = {
      list: async () => ['abc123'],
      copy: (_m: LocalModel, onProgress: (p: { bytesDone: number; bytesTotal: number }) => void) => {
        onProgress({ bytesDone: 5, bytesTotal: 10 });
        return new Promise<string>((r) => (finish = () => r('v')));
      },
      remove: async () => {},
    } as unknown as ModelVolumes;
    const { a, events } = app(volumes, async (id) => (id === 'abc123' ? model : undefined));
    expect(await (await a.request('/api/docker/model-volumes')).json()).toEqual({ localIds: ['abc123'] });
    const post = (id: string) => a.request('/api/docker/model-volumes', { method: 'POST', body: JSON.stringify({ localId: id }) });
    expect((await post('nope')).status).toBe(404);
    expect(await (await post('abc123')).json()).toEqual({ ok: true });
    expect((await post('abc123')).status).toBe(409);
    finish();
    await new Promise((r) => setTimeout(r, 5));
    expect(events.map((e) => (e as { stage: string }).stage)).toEqual(['copy', 'done']);
    expect(await (await a.request('/api/docker/model-volumes/abc123', { method: 'DELETE' })).json()).toEqual({ ok: true });
  });

  it('publishes copy errors and aborts on shutdown', async () => {
    let seen: AbortSignal | undefined;
    const volumes = {
      copy: (_m: LocalModel, _p: unknown, signal: AbortSignal) => {
        seen = signal;
        return Promise.reject(new Error('disk full'));
      },
    } as unknown as ModelVolumes;
    const { a, events, shutdown } = app(volumes, async () => model);
    await a.request('/api/docker/model-volumes', { method: 'POST', body: JSON.stringify({ localId: 'abc123' }) });
    await new Promise((r) => setTimeout(r, 5));
    expect(events.at(-1)).toMatchObject({ stage: 'error', error: { message: 'disk full' } });
    shutdown.abort();
    expect(seen?.aborted).toBe(true);
  });
});
