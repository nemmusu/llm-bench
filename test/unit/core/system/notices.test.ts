import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { APP_NOTICES_FILE, parseAppNotices, withAppNotices, type AppNotice } from '../../../../src/contract/app-notices';
import type { CoreContext } from '../../../../src/core/context';
import type { CoreDeps } from '../../../../src/core/deps';
import { createApp } from '../../../../src/core/server/app';
import { createAppNoticeRoutes } from '../../../../src/core/system/notices';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const PORT = 4321;
const TOKEN = 't';
const MOVED: AppNotice = { id: 'data-moved', kind: 'data-moved', mode: 'moved', from: 'C:\\Users\\a\\AppData\\Roaming\\GPU Bench' };
const TOKEN_GONE: AppNotice = { id: 'secret-unreadable:hf-token', kind: 'secret-unreadable', secret: 'hf-token', renamed: true };

function setup(content?: string) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'llmbench-notices-'));
  dirs.push(dir);
  const file = path.join(dir, APP_NOTICES_FILE);
  if (content !== undefined) writeFileSync(file, content);
  const ctx = { deps: { appVersion: '0.4.0-test', paths: { dataDir: dir } } as unknown as CoreDeps } as unknown as CoreContext;
  const app = createApp(ctx, { token: TOKEN, port: () => PORT, modules: [createAppNoticeRoutes()] });
  const call = async (method: string, url: string) => {
    const res = await app.request(`http://127.0.0.1:${PORT}${url}`, { method, headers: { host: `127.0.0.1:${PORT}`, authorization: `Bearer ${TOKEN}` } });
    return { status: res.status, body: (await res.json()) as unknown };
  };
  return { file, call };
}

describe('the app’s one-time notices (/api/app/notices)', () => {
  it('lists what the main process wrote; a dismissed one is gone for good', async () => {
    const { file, call } = setup(JSON.stringify([MOVED, TOKEN_GONE]));
    expect(await call('GET', '/api/app/notices')).toEqual({ status: 200, body: [MOVED, TOKEN_GONE] });
    expect(await call('DELETE', '/api/app/notices/data-moved')).toEqual({ status: 200, body: { ok: true } });
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual([TOKEN_GONE]);
    // Unknown id: nothing changes.
    expect((await call('DELETE', '/api/app/notices/nope')).status).toBe(200);
    expect((await call('GET', '/api/app/notices')).body).toEqual([TOKEN_GONE]);
    await call('DELETE', `/api/app/notices/${encodeURIComponent(TOKEN_GONE.id)}`);
    expect((await call('GET', '/api/app/notices')).body).toEqual([]);
  });

  it('no file, a damaged one, invalid entries: what is valid, never an error', async () => {
    expect((await setup().call('GET', '/api/app/notices')).body).toEqual([]);
    expect((await setup('{oops').call('GET', '/api/app/notices')).body).toEqual([]);
    expect((await setup('{"a":1}').call('GET', '/api/app/notices')).body).toEqual([]);
    expect((await setup(JSON.stringify([{ id: 'x' }, MOVED])).call('GET', '/api/app/notices')).body).toEqual([MOVED]);
    const none = setup();
    expect((await none.call('DELETE', '/api/app/notices/data-moved')).status).toBe(200);
  });

  it('withAppNotices: a notice replaces the older one with its id', () => {
    expect(withAppNotices([MOVED, TOKEN_GONE], [{ ...MOVED, mode: 'copied' }])).toEqual([TOKEN_GONE, { ...MOVED, mode: 'copied' }]);
    expect(parseAppNotices('x')).toEqual([]);
  });
});
