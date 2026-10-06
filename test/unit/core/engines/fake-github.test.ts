import { mkdtempSync, writeFileSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { extractArchive } from '../../../../src/core/engines/archive';
import { buildAsset, startFakeGithub, type FakeGithub } from '../../../fakes/fake-github/server.mjs';

const tmp = () => mkdtempSync(path.join(os.tmpdir(), 'gb-fgh-'));
async function entries(name: string, buf: Buffer): Promise<string[]> {
  const dir = tmp();
  const file = path.join(dir, name);
  writeFileSync(file, buf);
  const out = path.join(dir, 'x');
  await extractArchive(file, out, { symlink: async () => {} });
  return readdirSync(out, { recursive: true }).map(String).sort();
}

describe('fake-github assets', () => {
  it('Windows zips are flat, Linux tarballs wrap llama-<tag>/; layouts can be swapped', async () => {
    expect(await entries('a.zip', buildAsset('llama-b7-bin-win-cuda-13.4-x64.zip'))).toContain('llama-server.exe');
    expect(await entries('a.tar.gz', buildAsset('llama-b7-bin-ubuntu-x64.tar.gz'))).toContain(path.join('llama-b7', 'llama-server'));
    expect(await entries('a.zip', buildAsset('llama-b7-bin-win-cpu-x64.zip', { layout: 'nested' }))).toContain(path.join('llama-b7', 'llama-server.exe'));
    expect(await entries('a.tar.gz', buildAsset('llama-b7-bin-ubuntu-vulkan-x64.tar.gz', { layout: 'flat' }))).toContain('llama-server');
    expect(await entries('c.tar.gz', buildAsset('cudart-llama-b7-bin-ubuntu-cuda-13.4-x64.tar.gz'))).toContain(path.join('cudart-llama-b7', 'libcudart.so.13'));
    expect(buildAsset('llama-b7-ui.txt').toString()).toContain('fake asset');
  });

  it('hostile variants are rejected by the extractor', async () => {
    await expect(entries('e.zip', buildAsset('llama-b7-bin-win-cpu-x64.zip', { evil: 'absolute' }))).rejects.toMatchObject({ params: { reason: 'unsafe-archive' } });
    // symlink-out is skipped silently, everything else extracts.
    expect(await entries('s.zip', buildAsset('llama-b7-bin-win-cpu-x64.zip', { evil: 'symlink-out' }))).not.toContain('escape');
  });
});

describe('fake-github server', () => {
  let gh: FakeGithub;
  beforeAll(async () => {
    gh = await startFakeGithub({ releases: [] });
  });
  afterAll(() => gh.close());

  it('custom release list, forced download status, 404 elsewhere', async () => {
    expect(await (await fetch(`${gh.url}/repos/ggml-org/llama.cpp/releases`)).json()).toEqual([]);
    gh.set({ downloadStatus: 503 });
    expect((await fetch(`${gh.url}/download/b1/x.zip`)).status).toBe(503);
    gh.set({ downloadStatus: undefined });
    expect((await fetch(`${gh.url}/download/b1/llama-b1-bin-win-cpu-x64.zip`)).headers.get('content-length')).toMatch(/^\d+$/);
    expect((await fetch(`${gh.url}/elsewhere`)).status).toBe(404);
    expect(gh.requests.length).toBe(4);
  });
});
