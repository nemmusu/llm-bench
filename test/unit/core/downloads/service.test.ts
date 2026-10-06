import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ServerEvent } from '../../../../src/contract/events';
import type { DownloadJob } from '../../../../src/contract/models';
import type { Clock } from '../../../../src/core/deps';
import { DownloadService, vllmRepoFiles, type DownloadServiceOptions } from '../../../../src/core/downloads/service';
import { HubClient } from '../../../../src/core/models/hub';
import { DOWNLOAD_SIDECAR } from '../../../../src/core/models/scanner';
import { systemClock } from '../../../../src/core/node-deps';
import { startFakeHub, type FakeHub } from '../../../fakes/fake-hub';
import { memoryLogger } from '../models/helpers';

const REPO = 'ggml-org/Qwen3-0.6B-GGUF';
const Q4 = 'Qwen3-0.6B-Q4_K_M.gguf';
const Q8 = 'Qwen3-0.6B-Q8_0.gguf';

async function waitFor(check: () => boolean, ms = 8000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe('vllmRepoFiles', () => {
  it('keeps what vLLM needs and drops other formats and originals', () => {
    const f = (p: string) => ({ path: p, sizeBytes: 1, kind: 'other' as const });
    const files = ['config.json', 'model-00001-of-00002.safetensors', 'pytorch_model-00001-of-00002.bin', 'original/consolidated.00.pth', 'original/params.json', 'onnx/model.onnx', 'x.gguf', 'tokenizer.json', 'flax_model.msgpack', 'README.md'].map(f);
    expect(vllmRepoFiles(files)).toEqual(['config.json', 'model-00001-of-00002.safetensors', 'tokenizer.json', 'README.md']);
    expect(vllmRepoFiles([f('pytorch_model.bin'), f('config.json')])).toEqual(['pytorch_model.bin', 'config.json']);
  });
});

describe('DownloadService', () => {
  let hub: FakeHub;
  let dir: string;
  let events: ServerEvent[];
  let token: string | undefined;
  let completed: DownloadJob[];
  let log: ReturnType<typeof memoryLogger>;
  const services: DownloadService[] = [];

  beforeAll(async () => {
    hub = await startFakeHub();
  });
  afterAll(() => hub.close());
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'gb-dlsvc-'));
    events = [];
    token = undefined;
    completed = [];
    log = memoryLogger();
    Object.assign(hub.behavior, { throttleBytesPerSec: 0, dropAfterBytes: 0, dropTimes: 0, failNext: undefined, corrupt: [] });
    hub.requests.length = 0;
  });
  afterEach(async () => {
    hub.behavior.throttleBytesPerSec = 0;
    for (const s of services.splice(0)) await s.idle();
    rmSync(dir, { recursive: true, force: true });
  });

  const models = () => path.join(dir, 'models');
  function service(over: Partial<DownloadServiceOptions> = {}): DownloadService {
    const client = new HubClient({ fetch: globalThis.fetch, baseUrl: hub.url, getToken: () => token });
    let n = 0;
    const svc = new DownloadService({
      fetch: globalThis.fetch,
      clock: systemClock,
      log,
      dataDir: path.join(dir, 'data'),
      modelsDir: () => Promise.resolve(models()),
      hub: client,
      publish: (e) => events.push(e),
      onComplete: (job) => {
        completed.push(job);
      },
      statfs: async () => ({ bavail: 1e12, bsize: 1 }),
      backoffMs: 1,
      newId: () => `job-${++n}`,
      ...over,
    });
    services.push(svc);
    return svc;
  }
  const states = (id: string) => events.filter((e): e is Extract<ServerEvent, { type: 'download.update' }> => e.type === 'download.update' && e.job.id === id).map((e) => e.job.state);
  const dedupe = (xs: string[]) => xs.filter((x, i) => x !== xs[i - 1]);

  it('downloads a GGUF into <models>/<owner>/<repo>, writes the sidecar and persists the queue', async () => {
    const svc = service();
    await svc.init();
    const job = await svc.add({ repo: REPO, revision: 'main', files: [Q4] });
    // Scheduling is immediate: the returned snapshot already shows the job starting.
    expect(job).toMatchObject({ id: 'job-1', label: `${REPO} · ${Q4}`, repo: REPO, state: 'running', bytesDone: 0, dest: path.join(models(), 'ggml-org', 'Qwen3-0.6B-GGUF') });
    expect(job.files).toEqual([{ path: Q4, sizeBytes: hub.file(REPO, Q4).size, sha256: hub.file(REPO, Q4).sha256 }]);
    await svc.idle();
    const done = svc.list()[0] as DownloadJob;
    expect(done).toMatchObject({ state: 'done', bytesDone: done.bytesTotal });
    expect(done.bytesPerSec).toBeUndefined();
    expect(dedupe(states('job-1'))).toEqual(['queued', 'running', 'done']);
    expect(readFileSync(path.join(job.dest, Q4))).toEqual(hub.file(REPO, Q4).bytes);
    const sidecar = JSON.parse(readFileSync(path.join(job.dest, DOWNLOAD_SIDECAR), 'utf8'));
    expect(sidecar).toEqual({ repo: REPO, revision: hub.repo(REPO).sha, files: { [Q4]: { sha256: hub.file(REPO, Q4).sha256, sizeBytes: hub.file(REPO, Q4).size } } });
    expect(completed.map((j) => j.id)).toEqual(['job-1']);
    const persisted = JSON.parse(readFileSync(path.join(dir, 'data', 'downloads.json'), 'utf8'));
    expect(persisted.jobs[0]).toMatchObject({ revision: 'main', done: [Q4], commit: hub.repo(REPO).sha, job: { state: 'done' } });
    // Second file of the same repo: the sidecar is merged.
    await svc.add({ repo: REPO, revision: 'main', files: [Q8], label: 'Q8 please' });
    await svc.idle();
    expect(Object.keys(JSON.parse(readFileSync(path.join(job.dest, DOWNLOAD_SIDECAR), 'utf8')).files).sort()).toEqual([Q4, Q8]);
    expect(svc.list()[1]?.label).toBe('Q8 please');
  });

  it('downloads a whole safetensors repo for vLLM with files ["*"]', async () => {
    const svc = service();
    const job = await svc.add({ repo: 'Qwen/Qwen3-0.6B', revision: 'main', files: ['*'] });
    expect(job.label).toBe('Qwen/Qwen3-0.6B');
    expect(job.files.map((f) => f.path).sort()).toEqual(['README.md', 'config.json', 'generation_config.json', 'merges.txt', 'model.safetensors', 'tokenizer.json', 'tokenizer_config.json', 'vocab.json']);
    await svc.idle();
    expect(svc.list()[0]?.state).toBe('done');
    expect(existsSync(path.join(models(), 'Qwen', 'Qwen3-0.6B', 'model.safetensors'))).toBe(true);
    expect(existsSync(path.join(models(), 'Qwen', 'Qwen3-0.6B', 'original'))).toBe(false);
  });

  it('validates requests', async () => {
    const svc = service();
    await expect(svc.add({ repo: 'bad', revision: 'main', files: ['x'] })).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(svc.add({ repo: REPO, revision: 'main', files: ['../evil.gguf'] })).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(svc.add({ repo: REPO, revision: 'main', files: ['nope.gguf'] })).rejects.toMatchObject({ code: 'HF_NOT_FOUND', params: { file: 'nope.gguf' } });
    hub.addRepo({ id: 'only/Gguf', files: [{ path: 'm.gguf', size: 10 }] });
    await expect(svc.add({ repo: 'only/Gguf', revision: 'main', files: ['*'] })).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(svc.pause('missing')).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('runs at most two jobs at once and dedupes identical requests', async () => {
    hub.behavior.throttleBytesPerSec = 400 * 1024;
    hub.addRepo({ id: 'third/Repo-GGUF', files: [{ path: 'r-Q4_K_M.gguf', size: 64 * 1024 }] });
    const svc = service();
    const a = await svc.add({ repo: REPO, revision: 'main', files: [Q4] });
    expect((await svc.add({ repo: REPO, revision: 'main', files: [Q4] })).id).toBe(a.id);
    await svc.add({ repo: REPO, revision: 'main', files: [Q8] });
    const c = await svc.add({ repo: 'third/Repo-GGUF', revision: 'main', files: ['r-Q4_K_M.gguf'] });
    let maxRunning = 0;
    await waitFor(() => {
      maxRunning = Math.max(maxRunning, svc.list().filter((j) => j.state === 'running').length);
      return svc.list().every((j) => j.state === 'done');
    });
    expect(maxRunning).toBe(2);
    expect(states(c.id)[0]).toBe('queued');
  });

  it('pauses, resumes and cancels (keeping or deleting the .part)', async () => {
    hub.behavior.throttleBytesPerSec = 64 * 1024;
    const svc = service();
    const job = await svc.add({ repo: REPO, revision: 'main', files: [Q8] });
    await waitFor(() => (svc.list()[0]?.bytesDone ?? 0) > 16 * 1024);
    const paused = await svc.pause(job.id);
    expect(paused.state).toBe('paused');
    const part = path.join(job.dest, `${Q8}.part`);
    expect(existsSync(part)).toBe(true);
    expect((await svc.pause(job.id)).state).toBe('paused');
    hub.behavior.throttleBytesPerSec = 0;
    expect((await svc.resume(job.id)).state).toBe('running');
    await svc.idle();
    expect(svc.list()[0]?.state).toBe('done');
    await expect(svc.pause(job.id)).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(svc.resume(job.id)).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(svc.cancel(job.id)).rejects.toMatchObject({ code: 'VALIDATION' });
    // Resume of a later CDN range: the second request asked for the rest only.
    expect(hub.requests.filter((r) => r.origin === 'cdn').some((r) => typeof r.headers.range === 'string')).toBe(true);

    hub.behavior.throttleBytesPerSec = 64 * 1024;
    rmSync(path.join(job.dest, Q8));
    const again = await svc.add({ repo: REPO, revision: 'main', files: [Q8] });
    await waitFor(() => svc.list().find((j) => j.id === again.id)?.state === 'running' && existsSync(part));
    const cancelled = await svc.cancel(again.id);
    expect(cancelled.state).toBe('cancelled');
    expect(existsSync(part)).toBe(false);
    await expect(svc.cancel(again.id)).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('pauses and cancels queued jobs; resume of queued/running jobs is a no-op', async () => {
    hub.behavior.throttleBytesPerSec = 64 * 1024;
    const svc = service({ maxParallel: 1 });
    const a = await svc.add({ repo: REPO, revision: 'main', files: [Q8] });
    const b = await svc.add({ repo: REPO, revision: 'main', files: [Q4] });
    expect((await svc.resume(a.id)).state).toBe('running');
    expect((await svc.resume(b.id)).state).toBe('queued');
    expect((await svc.pause(b.id)).state).toBe('paused');
    expect((await svc.cancel(b.id)).state).toBe('cancelled');
    hub.behavior.throttleBytesPerSec = 0;
    await svc.idle();
  });

  it('marks failures (gated repo) and lets the user retry with resume', async () => {
    const svc = service();
    const job = await svc.add({ repo: 'google/gated-demo-it', revision: 'main', files: ['gated-demo-it-Q4_K_M.gguf'] });
    await svc.idle();
    const failed = svc.list()[0] as DownloadJob;
    expect(failed.state).toBe('failed');
    expect(failed.error?.code).toBe('HF_GATED');
    expect(log.entries.some((e) => e.msg === 'download failed')).toBe(true);
    token = 'hf_test_token';
    hub.setAccepted('google/gated-demo-it', true);
    const resumed = await svc.resume(job.id);
    expect(resumed.error).toBeUndefined();
    await svc.idle();
    expect(svc.list()[0]?.state).toBe('done');
    hub.setAccepted('google/gated-demo-it', false);
    // A failed job can also be cancelled.
    token = undefined;
    const other = await svc.add({ repo: 'google/gated-demo-it', revision: 'main', files: ['gated-demo-it-Q4_K_M.gguf'] });
    expect(other.id).not.toBe(job.id);
    await svc.idle();
    rmSync(path.join(other.dest, 'gated-demo-it-Q4_K_M.gguf'));
    // (it was skipped as already present; force a failure by retrying without access)
    await svc.idle();
    hub.addRepo({ id: 'google/gated-two', gated: 'manual', files: [{ path: 'g.gguf', size: 100 }] });
    const two = await svc.add({ repo: 'google/gated-two', revision: 'main', files: ['g.gguf'] });
    await svc.idle();
    expect(svc.list().find((j) => j.id === two.id)?.state).toBe('failed');
    expect((await svc.cancel(two.id)).state).toBe('cancelled');
  });

  it('refuses to start without enough free disk space', async () => {
    const svc = service({ statfs: async () => ({ bavail: 10n, bsize: 4096n }) });
    await svc.add({ repo: REPO, revision: 'main', files: [Q4] });
    await svc.idle();
    expect(svc.list()[0]).toMatchObject({ state: 'failed', error: { code: 'DISK_FULL' } });
  });

  it('skips files already on disk with the right size', async () => {
    const dest = path.join(models(), 'ggml-org', 'Qwen3-0.6B-GGUF');
    mkdirSync(dest, { recursive: true });
    writeFileSync(path.join(dest, Q4), hub.file(REPO, Q4).bytes);
    const svc = service();
    await svc.add({ repo: REPO, revision: 'main', files: [Q4] });
    await svc.idle();
    expect(svc.list()[0]?.state).toBe('done');
    expect(hub.requests.filter((r) => r.url.includes('/resolve/'))).toHaveLength(0);
  });

  it('reports EWMA speed and ETA, throttling progress events to the window', async () => {
    let t = 0;
    const clock: Clock = { now: () => (t += 120), wall: () => 1_700_000_000_000, sleep: () => Promise.resolve() };
    const svc = service({ clock, throttleMs: 250 });
    hub.behavior.throttleBytesPerSec = 512 * 1024;
    await svc.add({ repo: REPO, revision: 'main', files: [Q8] });
    let sawSpeed = false;
    await waitFor(() => {
      const j = svc.list()[0];
      if (j?.bytesPerSec !== undefined && j.etaSec !== undefined) sawSpeed = true;
      return j?.state === 'done';
    });
    expect(sawSpeed).toBe(true);
    const progress = events.filter((e) => e.type === 'download.update' && e.job.state === 'running');
    expect(progress.length).toBeGreaterThan(1);
    expect(svc.list()[0]?.createdAt).toBe(new Date(1_700_000_000_000).toISOString());
  });

  it('reports no ETA while the measured speed is zero', async () => {
    let t = 0;
    const clock: Clock = { now: () => (t += 600), wall: () => 0, sleep: () => Promise.resolve() };
    const dest = path.join(models(), 'ggml-org', 'Qwen3-0.6B-GGUF');
    mkdirSync(dest, { recursive: true });
    // A complete .part: the first file reports its size once and finishes without transfer.
    writeFileSync(path.join(dest, `${Q4}.part`), hub.file(REPO, Q4).bytes);
    const etas: (number | undefined)[] = [];
    const svc = service({
      clock,
      publish: (e) => {
        if (e.type === 'download.update') etas.push(e.job.bytesPerSec === 0 ? e.job.etaSec : -1);
      },
    });
    await svc.add({ repo: REPO, revision: 'main', files: [Q4, Q8] });
    await svc.idle();
    expect(svc.list()[0]?.state).toBe('done');
    expect(etas).toContain(undefined);
  });

  it('sends a trailing progress event when updates come faster than the window', async () => {
    const clock: Clock = { now: () => 0, wall: () => 0, sleep: () => Promise.resolve() };
    hub.behavior.throttleBytesPerSec = 256 * 1024;
    const svc = service({ clock, throttleMs: 30 });
    await svc.add({ repo: REPO, revision: 'main', files: [Q4] });
    await svc.idle();
    await new Promise((r) => setTimeout(r, 60));
    const updates = events.filter((e) => e.type === 'download.update');
    expect(updates.length).toBeGreaterThanOrEqual(3);
  });

  it('restores jobs after a restart: running → paused, queued restarts, garbage ignored', async () => {
    hub.behavior.throttleBytesPerSec = 64 * 1024;
    const first = service();
    const job = await first.add({ repo: REPO, revision: 'main', files: [Q8] });
    await waitFor(() => (first.list()[0]?.bytesDone ?? 0) > 16 * 1024);
    await first.pause(job.id);
    const saved = JSON.parse(readFileSync(path.join(dir, 'data', 'downloads.json'), 'utf8'));
    saved.jobs[0].job.state = 'running';
    saved.jobs.push({ ...saved.jobs[0], job: { ...saved.jobs[0].job, id: 'queued-1', state: 'queued', files: [{ path: Q4, sizeBytes: hub.file(REPO, Q4).size, sha256: hub.file(REPO, Q4).sha256 }] }, done: [] });
    saved.jobs.push({ ...saved.jobs[0], job: { ...saved.jobs[0].job, id: 'done-1', state: 'done' }, done: [Q8] });
    writeFileSync(path.join(dir, 'data', 'downloads.json'), JSON.stringify(saved));
    hub.behavior.throttleBytesPerSec = 0;
    const second = service();
    await second.init();
    const restored = second.list().find((j) => j.id === job.id) as DownloadJob;
    expect(restored.state).toBe('paused');
    expect(restored.bytesDone).toBeGreaterThan(16 * 1024);
    expect(second.list().find((j) => j.id === 'done-1')?.bytesDone).toBe(hub.file(REPO, Q8).size);
    await second.idle();
    expect(second.list().find((j) => j.id === 'queued-1')?.state).toBe('done');
    await second.resume(job.id);
    await second.idle();
    expect(second.list().find((j) => j.id === job.id)?.state).toBe('done');

    // Older state files: no commit, no totals, files without sizes; finished files are skipped.
    const legacy = {
      version: 1,
      jobs: [
        {
          revision: 'main',
          done: [Q4],
          job: { id: 'legacy-1', label: 'legacy', repo: REPO, files: [{ path: Q4, sizeBytes: hub.file(REPO, Q4).size }, { path: Q8, sha256: hub.file(REPO, Q8).sha256 }], dest: restored.dest, state: 'queued', bytesDone: 0, createdAt: '2026-01-01T00:00:00.000Z' },
        },
      ],
    };
    rmSync(path.join(restored.dest, Q8));
    writeFileSync(path.join(dir, 'data', 'downloads.json'), JSON.stringify(legacy));
    const fourth = service();
    await fourth.init();
    expect(fourth.list()[0]?.bytesTotal).toBe(hub.file(REPO, Q4).size);
    await fourth.idle();
    expect(fourth.list()[0]?.state).toBe('done');
    expect(readFileSync(path.join(restored.dest, Q8))).toEqual(hub.file(REPO, Q8).bytes);

    writeFileSync(path.join(dir, 'data', 'downloads.json'), '{"version": 2}');
    const third = service();
    await third.init();
    expect(third.list()).toEqual([]);
  });

  it('pauses running jobs on core shutdown and keeps finished history bounded', async () => {
    hub.behavior.throttleBytesPerSec = 64 * 1024;
    const shutdown = new AbortController();
    const svc = service({ signal: shutdown.signal });
    hub.behavior.throttleBytesPerSec = 0;
    await svc.add({ repo: REPO, revision: 'main', files: [Q4] });
    await svc.idle();
    hub.behavior.throttleBytesPerSec = 64 * 1024;
    const running = await svc.add({ repo: REPO, revision: 'main', files: [Q8] });
    await waitFor(() => svc.list()[1]?.state === 'running');
    shutdown.abort();
    await svc.idle();
    expect(svc.list().map((j) => j.state)).toEqual(['done', 'paused']);
    // No new work starts after shutdown.
    expect((await svc.resume(running.id)).state).toBe('queued');

    hub.behavior.throttleBytesPerSec = 0;
    const many = service({ newId: undefined });
    hub.addRepo({ id: 'many/Files', files: Array.from({ length: 52 }, (_, i) => ({ path: `f${i}.bin`, size: 16 })) });
    for (let i = 0; i < 52; i++) {
      await many.add({ repo: 'many/Files', revision: 'main', files: [`f${i}.bin`] });
      await many.idle();
    }
    const saved = JSON.parse(readFileSync(path.join(dir, 'data', 'downloads.json'), 'utf8'));
    expect(saved.jobs.length).toBe(50);
    expect(many.list()[0]?.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('survives a failing completion hook and an unwritable state file', async () => {
    writeFileSync(path.join(dir, 'data-is-a-file'), 'x');
    const svc = service({
      dataDir: path.join(dir, 'data-is-a-file'),
      onComplete: () => {
        throw new Error('rescan exploded');
      },
    });
    await svc.add({ repo: REPO, revision: 'main', files: [Q4] });
    await svc.idle();
    expect(svc.list()[0]?.state).toBe('done');
    expect(log.entries.some((e) => e.msg === 'download completion hook failed')).toBe(true);
    expect(log.entries.some((e) => e.msg === 'cannot save downloads state')).toBe(true);
    // Without a hook at all.
    const bare = service({ onComplete: undefined, dataDir: path.join(dir, 'd2') });
    await bare.add({ repo: REPO, revision: 'main', files: [Q8] });
    await bare.idle();
    expect(bare.list()[0]?.state).toBe('done');
  });

  it('backs off on dropped connections through the injected clock', async () => {
    const slept: number[] = [];
    const clock: Clock = { ...systemClock, sleep: (ms) => (slept.push(ms), Promise.resolve()) };
    hub.behavior.dropAfterBytes = 20_000;
    hub.behavior.dropTimes = 1;
    const svc = service({ clock, backoffMs: 7 });
    await svc.add({ repo: REPO, revision: 'main', files: [Q8] });
    await svc.idle();
    expect(svc.list()[0]?.state).toBe('done');
    expect(slept).toEqual([7]);
  });

  it('records the requested revision when the hub sends no commit sha', async () => {
    const noCommit = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const res = await globalThis.fetch(input, init);
      const headers = new Headers(res.headers);
      headers.delete('x-repo-commit');
      return new Response(res.status === 302 || res.status === 304 ? null : res.body, { status: res.status, headers });
    }) as typeof fetch;
    const svc = service({ fetch: noCommit });
    const job = await svc.add({ repo: REPO, revision: 'main', files: [Q4] });
    await svc.idle();
    expect(JSON.parse(readFileSync(path.join(job.dest, DOWNLOAD_SIDECAR), 'utf8')).revision).toBe('main');
    await svc.add({ repo: REPO, revision: 'main', files: [Q8] });
    await svc.idle();
    expect(JSON.parse(readFileSync(path.join(job.dest, DOWNLOAD_SIDECAR), 'utf8')).revision).toBe('main');
  });

  it('uses the real statfs and default limits', async () => {
    const svc = service({ statfs: undefined, maxRetries: 0, backoffMs: undefined });
    await svc.add({ repo: REPO, revision: 'main', files: [Q4] });
    await svc.idle();
    expect(svc.list()[0]?.state).toBe('done');
  });
});
