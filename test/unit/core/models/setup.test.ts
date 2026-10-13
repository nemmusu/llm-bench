import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Hono } from 'hono';
import type { ServerEvent } from '../../../../src/contract/events';
import type { CoreContext } from '../../../../src/core/context';
import { createModelServices } from '../../../../src/core/models/setup';
import { EventHub } from '../../../../src/core/server/event-hub';
import { errorResponse } from '../../../../src/core/server/http-error';
import { SettingsRepo } from '../../../../src/core/store/settings-repo';
import { startFakeHub, type FakeHub } from '../../../fakes/fake-hub';
import { GPU_32GB, modelDeps, tempDir } from './helpers';

describe('createModelServices (wiring)', () => {
  let hub: FakeHub;
  let t: ReturnType<typeof tempDir>;
  const shutdowns: AbortController[] = [];
  beforeAll(async () => {
    hub = await startFakeHub();
  });
  afterAll(() => hub.close());
  beforeEach(() => {
    t = tempDir('gb-setup-');
  });
  afterEach(() => {
    // Ends the daily update check's wait, as the core's shutdown does.
    for (const c of shutdowns.splice(0)) c.abort();
    t.cleanup();
  });

  async function context(): Promise<{ ctx: CoreContext; events: ServerEvent[]; shutdown: AbortController }> {
    const deps = modelDeps(t.dir, { endpoints: { githubApi: '', huggingface: hub.url, dockerHub: '' } });
    const shutdown = new AbortController();
    shutdowns.push(shutdown);
    // Telemetry and sysinfo are not used by the models/downloads services.
    const ctx: CoreContext = { deps, hub: new EventHub(), settings: new SettingsRepo(deps.paths.dataDir), shutdown: shutdown.signal, secrets: {}, telemetry: {} as never, sysinfo: {} as never };
    // Never scan (or hash) the developer's real model folders from unit tests.
    await ctx.settings.update({ scanKnownLocations: false });
    const events: ServerEvent[] = [];
    ctx.hub.subscribe((e) => events.push(e));
    return { ctx, events, shutdown };
  }

  it('builds services and routes; a finished download is published and rescanned', async () => {
    const { ctx, events } = await context();
    const ms = createModelServices(ctx, { gpuInfo: () => Promise.resolve(GPU_32GB), autoHash: false, statfs: async () => ({ bavail: 1e12, bsize: 1 }) });
    await ms.init();
    const app = new Hono();
    app.onError((e, c) => errorResponse(c, e));
    for (const r of ms.routes) r(app, ctx);
    const res = await app.request('/api/downloads', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repo: 'ggml-org/Qwen3-0.6B-GGUF', files: ['Qwen3-0.6B-Q4_K_M.gguf'] }),
    });
    expect(res.status).toBe(200);
    await ms.downloads.idle();
    const dest = path.join(t.dir, 'library', 'ggml-org', 'Qwen3-0.6B-GGUF');
    expect(existsSync(path.join(dest, 'Qwen3-0.6B-Q4_K_M.gguf'))).toBe(true);
    expect(events.some((e) => e.type === 'download.update' && e.job.state === 'done')).toBe(true);
    const local = await ms.models.list();
    expect(local[0]?.identity).toMatchObject({ repo: 'ggml-org/Qwen3-0.6B-GGUF', sha256: hub.file('ggml-org/Qwen3-0.6B-GGUF', 'Qwen3-0.6B-Q4_K_M.gguf').sha256, revision: hub.repo('ggml-org/Qwen3-0.6B-GGUF').sha });
    expect(readdirSync(dest).sort()).toEqual(['.gpubench-download.json', 'Qwen3-0.6B-Q4_K_M.gguf']);
    // The weak key of the downloaded copy equals the one the hub listing announces for it.
    const hubSide = await ms.models.hubFit('ggml-org/Qwen3-0.6B-GGUF', 'llamacpp-native');
    expect(hubSide.choices.map((c) => c.weakKey)).toContain(local[0]?.identity.weakKey);
    // Plans see the repo's copies on the PC (the models' folders) and what the hash cache knows.
    const q4 = readFileSync(path.join(dest, 'Qwen3-0.6B-Q4_K_M.gguf'));
    writeFileSync(path.join(dest, 'Qwen3-0.6B-Q8_0.gguf'), q4);
    writeFileSync(path.join(t.dir, 'library', 'loose-Q8_0.gguf'), q4);
    const rescanned = await ms.models.rescan();
    const folders = await ms.models.repoFolders('ggml-org/Qwen3-0.6B-GGUF');
    expect(folders).toEqual([{ dir: dest, modelIds: expect.arrayContaining(rescanned.filter((m) => m.identity.repo).map((m) => m.id)) }]);
    expect(folders[0]?.modelIds).toHaveLength(2);
    const planRes = await app.request('/api/downloads/plan', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repo: 'ggml-org/Qwen3-0.6B-GGUF', files: ['Qwen3-0.6B-Q4_K_M.gguf', 'Qwen3-0.6B-Q8_0.gguf'] }),
    });
    const plan = (await planRes.json()) as { dest: string; files: { local: string }[] };
    expect(plan.dest).toBe(dest);
    // The Q8 copy is not the hub's Q8 (another size): an update.
    expect(plan.files.map((f) => f.local)).toEqual(['have', 'update']);
    // The HF token pushed into the context is used for gated repos.
    ctx.secrets.hfToken = 'hf_test_token';
    hub.setAccepted('google/gated-demo-it', true);
    expect((await ms.models.remoteGgufFacts('google/gated-demo-it', 'gated-demo-it-Q4_K_M.gguf')).facts.name).toBe('Gated');
    hub.setAccepted('google/gated-demo-it', false);
  });

  it('uses defaults for hashing and disk checks', async () => {
    const { ctx } = await context();
    const ms = createModelServices(ctx, { gpuInfo: () => Promise.resolve(undefined) });
    await ms.init();
    expect(await ms.models.list()).toEqual([]);
    expect(ms.downloads.list()).toEqual([]);
  });
});
