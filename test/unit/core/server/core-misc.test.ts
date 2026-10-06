import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { AppError, isAppError, toAppErrorData } from '../../../../src/contract/errors';
import { defaultSettings } from '../../../../src/contract/settings';
import { createCore } from '../../../../src/core/index';
import { createLogger, systemClock } from '../../../../src/core/node-deps';
import { EventHub } from '../../../../src/core/server/event-hub';
import { statusFor } from '../../../../src/core/server/http-error';
import { SettingsRepo } from '../../../../src/core/store/settings-repo';
import { tempDir, testDeps } from './helpers';

describe('EventHub', () => {
  it('keeps publishing when a listener throws, and unsubscribes', () => {
    const hub = new EventHub();
    const seen: string[] = [];
    hub.subscribe(() => {
      throw new Error('bad listener');
    });
    const off = hub.subscribe((e) => seen.push(e.type));
    hub.publish({ type: 'runs.changed' });
    off();
    hub.publish({ type: 'runs.changed' });
    expect(seen).toEqual(['runs.changed']);
    expect(hub.size).toBe(1);
  });
});

describe('errors', () => {
  it('serializes AppError with optional params/detail and cause', () => {
    const plain = new AppError('NETWORK', 'down');
    expect(plain.toJSON()).toEqual({ code: 'NETWORK', message: 'down' });
    const full = new AppError('VRAM_BUSY', 'busy', { params: { pid: 3 }, detail: 'd', cause: new Error('c') });
    expect(full.toJSON()).toEqual({ code: 'VRAM_BUSY', message: 'busy', params: { pid: 3 }, detail: 'd' });
    expect(full.cause).toBeInstanceOf(Error);
    expect(isAppError(full)).toBe(true);
    expect(isAppError(new Error('x'))).toBe(false);
  });

  it('normalizes unknown throwables', () => {
    expect(toAppErrorData(new AppError('DISK_FULL', 'full'))).toEqual({ code: 'DISK_FULL', message: 'full' });
    const abort = new Error('stop');
    abort.name = 'AbortError';
    expect(toAppErrorData(abort).code).toBe('CANCELLED');
    expect(toAppErrorData(new Error('x'))).toEqual({ code: 'INTERNAL', message: 'x' });
    expect(toAppErrorData('weird')).toEqual({ code: 'INTERNAL', message: 'weird' });
  });

  it('maps codes to HTTP statuses', () => {
    expect(statusFor('VALIDATION')).toBe(400);
    expect(statusFor('HF_AUTH_REQUIRED')).toBe(401);
    expect(statusFor('ENGINE_OOM')).toBe(500);
  });
});

describe('SettingsRepo', () => {
  let t: ReturnType<typeof tempDir>;
  beforeEach(() => {
    t = tempDir();
  });
  afterEach(() => t.cleanup());

  it('falls back to defaults for a corrupt or invalid file', async () => {
    writeFileSync(path.join(t.dir, 'settings.json'), '{"language":"klingon"}');
    expect(await new SettingsRepo(t.dir).get()).toEqual(defaultSettings());
    writeFileSync(path.join(t.dir, 'settings.json'), 'not json');
    expect(await new SettingsRepo(t.dir).get()).toEqual(defaultSettings());
  });

  it('serializes concurrent updates', async () => {
    const repo = new SettingsRepo(t.dir);
    await Promise.all([repo.update({ theme: 'dark' }), repo.update({ language: 'en' }), repo.update({ expertMode: true })]);
    expect(await new SettingsRepo(t.dir).get()).toMatchObject({ theme: 'dark', language: 'en', expertMode: true });
    // A failed update does not block the next ones.
    await expect(repo.update({ language: 'xx' as never })).rejects.toThrow();
    expect((await repo.update({ density: 'compact' })).density).toBe('compact');
  });

  it('persists updates and serves them from cache', async () => {
    const repo = new SettingsRepo(t.dir);
    await repo.update({ theme: 'dark' });
    expect((await new SettingsRepo(t.dir).get()).theme).toBe('dark');
    expect(await repo.get()).toBe(await repo.get());
  });
});

describe('systemClock', () => {
  it('measures monotonic time and sleeps', async () => {
    const a = systemClock.now();
    await systemClock.sleep(5);
    expect(systemClock.now()).toBeGreaterThan(a);
    expect(systemClock.wall()).toBeGreaterThan(1_700_000_000_000);
  });

  it('rejects when aborted before or during the sleep', async () => {
    const pre = new AbortController();
    pre.abort();
    await expect(systemClock.sleep(1000, pre.signal)).rejects.toThrow();
    const pre2 = new AbortController();
    pre2.abort(new Error('custom'));
    await expect(systemClock.sleep(1000, pre2.signal)).rejects.toThrow('custom');
    const during = new AbortController();
    const p = systemClock.sleep(1000, during.signal);
    during.abort();
    await expect(p).rejects.toThrow();
    const during2 = new AbortController();
    const p2 = systemClock.sleep(1000, during2.signal);
    during2.abort(new Error('custom2'));
    await expect(p2).rejects.toThrow('custom2');
    // Non-Error reasons become a standard AbortError.
    const str = new AbortController();
    str.abort('why');
    await expect(systemClock.sleep(1000, str.signal)).rejects.toMatchObject({ name: 'AbortError' });
    const str2 = new AbortController();
    const p3 = systemClock.sleep(1000, str2.signal);
    str2.abort('why');
    await expect(p3).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('createLogger', () => {
  it('filters by level and writes JSON lines', () => {
    const lines: string[] = [];
    const log = createLogger((l) => lines.push(l), 'info');
    log.debug('hidden');
    log.info('hello', { a: 1 });
    log.warn('careful');
    log.error('bad');
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[0]!)).toMatchObject({ level: 'info', msg: 'hello', data: { a: 1 } });
    expect(JSON.parse(lines[1]!)).not.toHaveProperty('data');
    const all: string[] = [];
    const dbg = createLogger((l) => all.push(l));
    dbg.debug('x');
    expect(all).toHaveLength(0);
  });
});

describe('createCore', () => {
  let t: ReturnType<typeof tempDir>;
  beforeEach(() => {
    t = tempDir();
  });
  afterEach(() => t.cleanup());

  it('listens on loopback, answers with the token and closes cleanly', async () => {
    const core = await createCore(testDeps(t.dir), { token: 'tok', sseHeartbeatMs: 10 });
    expect(core.url).toBe(`http://127.0.0.1:${core.port}`);
    const res = await fetch(`${core.url}/api/health`, { headers: { authorization: 'Bearer tok' } });
    expect(res.status).toBe(200);
    // An open SSE stream must not block close().
    const sse = await fetch(`${core.url}/api/events`, { headers: { authorization: 'Bearer tok' } });
    expect(sse.status).toBe(200);
    await core.close();
    expect(core.ctx.shutdown.aborted).toBe(true);
  });

  it('picks up the HF token from the environment', async () => {
    const core = await createCore(testDeps(t.dir, { env: { GPUBENCH_HF_TOKEN: 'hf_x' } }), { token: 'tok' });
    expect(core.ctx.secrets.hfToken).toBe('hf_x');
    await core.close();
  });

  it('rejects when the port is taken', async () => {
    const first = await createCore(testDeps(t.dir), { token: 'a' });
    const log = vi.fn();
    await expect(
      createCore(testDeps(t.dir, { log: createLogger(log) }), { token: 'b', port: first.port }),
    ).rejects.toThrow();
    await first.close();
  });
});
