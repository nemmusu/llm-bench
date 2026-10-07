import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { configsResponseSchema, type ConfigsResponse } from '../../../../src/contract/configs';
import { createConfigRoutes } from '../../../../src/core/configs/routes';
import type { CoreContext } from '../../../../src/core/context';
import type { CoreDeps } from '../../../../src/core/deps';
import { createApp } from '../../../../src/core/server/app';
import { ConfigsIndex } from '../../../../src/core/store/configs-index';
import { RunsRepo } from '../../../../src/core/store/runs-repo';
import { hardware, makeRun, modelIdentity } from '../store/fixtures';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const PORT = 4321;
const TOKEN = 't';

async function setup() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'gb-configs-routes-'));
  dirs.push(dir);
  const runs = new RunsRepo(() => dir);
  const ctx = { deps: { appVersion: '0.1.0-test', paths: {} } as unknown as CoreDeps } as unknown as CoreContext;
  const here = { hostId: 'host-a', gpuUuid: 'GPU-aaaa', gpuName: 'NVIDIA GeForce RTX 5090' };
  const app = createApp(ctx, { token: TOKEN, port: () => PORT, modules: [createConfigRoutes(new ConfigsIndex(runs), async () => here)] });
  const get = async (url: string) => {
    const res = await app.request(`http://127.0.0.1:${PORT}${url}`, { headers: { host: `127.0.0.1:${PORT}`, authorization: `Bearer ${TOKEN}` } });
    return { status: res.status, body: (await res.json()) as unknown };
  };
  const launch = (args: string[]) => ({ ...makeRun().launch, argv: ['llama-server', '-m', 'm.gguf', ...args] });
  await runs.save(makeRun({ id: 'A1', createdAt: '2026-10-01T10:00:00.000Z', launch: launch(['-c', '32768', '-ctk', 'q8_0', '-ctv', 'q8_0']) }));
  await runs.save(makeRun({ id: 'A2', createdAt: '2026-10-02T10:00:00.000Z', launch: launch(['-ctv', 'q8_0', '-c', '32768', '-ctk', 'q8_0']) }));
  await runs.save(makeRun({ id: 'B1', createdAt: '2026-10-03T10:00:00.000Z', launch: launch(['-c', '4096']), engine: { kind: 'llamacpp-docker', name: 'llama.cpp', image: 'img:1' } }));
  await runs.save(makeRun({ id: 'C1', createdAt: '2026-10-04T10:00:00.000Z', launch: launch(['-c', '4096']), model: modelIdentity({ weakKey: 'other', displayName: 'Gemma' }) }));
  await runs.save(
    makeRun({ id: 'D1', createdAt: '2026-10-05T10:00:00.000Z', launch: launch(['-c', '4096']), hardware: hardware({ hostId: 'host-b', hostLabel: 'PC B', gpus: [{ ...hardware().gpus[0]!, uuid: 'GPU-bbbb', name: 'NVIDIA GeForce RTX 3070' }] }) }),
  );
  return { get };
}

const ids = (body: unknown) => (body as ConfigsResponse).configs.map((c) => c.sources.map((s) => s.runId).join('+'));

describe('GET /api/configs', () => {
  it('lists this PC’s configurations with their filters', async () => {
    const t = await setup();
    const all = await t.get('/api/configs');
    expect(all.status).toBe(200);
    const body = configsResponseSchema.parse(all.body);
    expect(body.gpu).toBe('gpu:GPU-aaaa');
    expect(ids(body)).toEqual(['C1', 'B1', 'A2+A1']);
    expect(body.gpus.map((g) => [g.name, g.here])).toEqual([
      ['NVIDIA GeForce RTX 5090', true],
      ['NVIDIA GeForce RTX 3070', false],
    ]);
    expect(body.engines).toEqual(['llamacpp-native', 'llamacpp-docker']);
    expect(body.models.map((m) => m.name)).toEqual(['Gemma', 'Qwen3 4B Q4_K_M']);
    expect(ids((await t.get('/api/configs?engine=llamacpp-docker')).body)).toEqual(['B1']);
    expect(ids((await t.get('/api/configs?model=weak:other')).body)).toEqual(['C1']);
    expect(ids((await t.get('/api/configs?minContext=32768')).body)).toEqual(['A2+A1']);
    expect(ids((await t.get('/api/configs?gpu=all')).body)).toEqual(['D1', 'C1', 'B1', 'A2+A1']);
    expect(ids((await t.get('/api/configs?gpu=gpu:GPU-bbbb')).body)).toEqual(['D1']);
  });

  it('refuses invalid filters', async () => {
    const t = await setup();
    const bad = await t.get('/api/configs?minContext=lots');
    expect(bad.status).toBe(400);
    expect(bad.body).toMatchObject({ error: { code: 'VALIDATION' } });
    expect((await t.get('/api/configs?engine=nope')).status).toBe(400);
  });
});
