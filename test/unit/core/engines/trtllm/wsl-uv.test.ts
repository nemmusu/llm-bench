// The Linux uv LLM Bench downloads itself for TensorRT-LLM inside WSL: checked, unpacked on this PC's disk,
// smoke-tested by the distro through /mnt/<drive>.
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { wslUv, wslUvDir } from '../../../../../src/core/engines/trtllm-native/wsl-uv';
import { systemClock } from '../../../../../src/core/node-deps';
import { makeTarGz } from '../../../../fakes/fake-github/archives.mjs';
import { ok, scriptedProc, tempDir } from '../../docker/helpers';

const VERSION = '0.12.23';
const ASSET = 'uv-x86_64-unknown-linux-gnu.tar.gz';
const TAR = makeTarGz([
  { name: 'uv-x86_64-unknown-linux-gnu/', type: 'dir' },
  { name: 'uv-x86_64-unknown-linux-gnu/uv', data: 'ELF uv', mode: 0o755 },
]);
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

const fetch = (async (input: string | URL | Request) => {
  const url = String(input);
  if (url.endsWith('/releases/latest')) {
    return Response.json({ tag_name: VERSION, assets: [{ name: ASSET, size: TAR.length, browser_download_url: `https://dl.test/${ASSET}` }, { name: `${ASSET}.sha256`, size: 1, browser_download_url: `https://dl.test/${ASSET}.sha256` }] });
  }
  if (url.endsWith('.sha256')) return new Response(`${sha(TAR)}  ${ASSET}\n`);
  return new Response(new Uint8Array(TAR), { headers: { 'content-length': String(TAR.length) } });
}) as typeof globalThis.fetch;

describe('Linux uv for WSL', () => {
  it('downloads, checks and smoke-tests it in the distro, then reuses it', async () => {
    const t = tempDir('gb-wsluv-');
    try {
      const proc = scriptedProc(() => ok(`uv ${VERSION} (abc 2026-10-03)\n`));
      const deps = { fetch, proc, clock: systemClock, arch: 'x64', appVersion: '1.0.0', paths: { dataDir: t.dir, cacheDir: t.dir, enginesDir: t.dir, resultsDir: t.dir, modelsDir: t.dir, resourcesDir: t.dir, home: t.dir } };
      const get = wslUv({ deps, wsl: ['wsl.exe'], githubApi: 'https://api.test' });
      const stages: string[] = [];
      const exe = await get('Ubuntu', (p) => stages.push(p.stage), new AbortController().signal);
      expect(exe).toBe(path.join(wslUvDir(t.dir), 'uv', VERSION, 'uv'));
      expect(existsSync(exe)).toBe(true);
      expect(stages).toContain('download');
      expect(stages.at(-1)).toBe('venv');
      // The smoke test ran in the distro, on the file's path there.
      const smoke = proc.calls.at(-1);
      expect(smoke?.cmd).toBe('wsl.exe');
      expect(smoke?.args.slice(0, 3)).toEqual(['-d', 'Ubuntu', '--exec']);
      expect(smoke?.args.at(-1)).toBe('--version');
      expect(smoke?.opts?.env).toMatchObject({ WSL_UTF8: '1' });
      const n = proc.calls.length;
      expect(await get('Ubuntu', () => undefined, new AbortController().signal)).toBe(exe);
      expect(proc.calls.length).toBe(n);
    } finally {
      t.cleanup();
    }
  });
});
