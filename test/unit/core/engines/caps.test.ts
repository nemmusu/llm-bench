import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { ProcessRunner, RunOutput } from '../../../../src/core/deps';
import { CapsProbe, capsFromOutputs, currentLlamaCaps, guessVariant, parseHelp, parseVersion } from '../../../../src/core/engines/llamacpp-native/caps';

const fixture = (name: string) => readFileSync(new URL(`../../../fixtures/llamacpp/${name}`, import.meta.url), 'utf8');
const HELP = fixture('help.stdout.txt');
const VERSION = fixture('version.stderr.txt');

describe('currentLlamaCaps', () => {
  it('matches what a real current build (b10997 --help) reports, for previews before the install', () => {
    const real = capsFromOutputs(VERSION, HELP);
    const assumed = currentLlamaCaps();
    for (const flag of assumed.flags) expect(real.flags.has(flag), flag).toBe(true);
    expect(assumed).toMatchObject({ flashAttn: real.flashAttn, fitFlag: real.fitFlag, nglKeywords: real.nglKeywords, tokenIdsInPrompt: true, timings: true });
    expect(real.cacheTypes).toEqual(expect.arrayContaining(assumed.cacheTypes));
  });
});

describe('parseVersion', () => {
  it('reads current builds (b10997 fixture)', () => {
    expect(parseVersion(VERSION)).toEqual({
      version: '0.4.1-dev',
      build: 'b10997',
      commit: 'fccf7166f',
      builtWith: 'Clang 20.1.8 for Windows x86_64',
    });
  });

  it('reads old builds and garbage', () => {
    expect(parseVersion('version: 4589 (a4417ddd)\nbuilt with cc (Ubuntu 13.2.0) 13.2.0 for x86_64-linux-gnu')).toEqual({
      version: 'b4589',
      build: 'b4589',
      commit: 'a4417ddd',
      builtWith: 'cc (Ubuntu 13.2.0) 13.2.0 for x86_64-linux-gnu',
    });
    expect(parseVersion('segfault')).toEqual({});
  });
});

describe('parseHelp (real b10997 --help)', () => {
  const entries = parseHelp(HELP);
  const byName = (n: string) => entries.find((e) => e.names.includes(n));

  it('collects every spelling, placeholder and enumerated values', () => {
    expect(byName('--help')?.names).toEqual(['-h', '--help', '--usage']);
    expect(byName('--no-webui')?.names).toEqual(['--ui', '--webui', '--no-ui', '--no-webui']);
    expect(byName('-ngl')?.names).toEqual(['-ngl', '--gpu-layers', '--n-gpu-layers']);
    expect(byName('-ngl')?.placeholder).toBe('N');
    expect(byName('-fa')?.values).toEqual(['on', 'off', 'auto']);
    expect(byName('--fit')?.values).toEqual(['on', 'off']);
    expect(byName('--split-mode')?.values).toEqual(['none', 'layer', 'row', 'tensor']);
    expect(byName('--cpu-strict')?.values).toEqual(['0', '1']);
    expect(byName('--poll')?.placeholder).toBe('<0...100>');
    expect(byName('--poll')?.values).toBeUndefined();
    expect(byName('--cache-type-k-draft')?.placeholder).toBe('TYPE');
    expect(byName('--cache-type-k-draft')?.desc).toMatch(/^KV cache data type/);
    expect(byName('--version')?.placeholder).toBeUndefined();
    expect(byName('-ngl')?.desc).toContain("'auto', or 'all'");
  });

  it('derives the capabilities used by the planner', () => {
    const caps = capsFromOutputs(VERSION, HELP);
    for (const f of ['--fit', '--no-webui', '-fa', '--alias', '-np', '--kv-unified', '-ctk', '-ctv', '--metrics', '--jinja', '-m', '--host', '--port']) {
      expect(caps.flags.has(f), f).toBe(true);
    }
    expect(caps.flags.has('--no-mmap')).toBe(false);
    expect(caps).toMatchObject({
      version: '0.4.1-dev',
      build: 'b10997',
      commit: 'fccf7166f',
      fitFlag: true,
      flashAttn: 'value',
      nglKeywords: ['auto', 'all'],
      tokenIdsInPrompt: true,
      timings: true,
      minTokens: false,
    });
    expect(caps.cacheTypes).toEqual(['f32', 'f16', 'bf16', 'q8_0', 'q4_0', 'q4_1', 'iq4_nl', 'q5_0', 'q5_1']);
  });

  it('old-style help: bare -fa toggle, no keywords, no cache type list, no version', () => {
    const old = [
      '-fa,   --flash-attn                     enable Flash Attention (default: disabled)',
      '-ngl,  --gpu-layers N                   number of layers to store in VRAM',
      '-ctk,  --cache-type-k TYPE              KV cache data type for K (default: f16)',
      '',
      '-z, (deprecated)                      trailing comma without another spelling',
      '----- section -----',
      '      indented line after a header is ignored',
    ].join('\n');
    const caps = capsFromOutputs('', old);
    expect(caps).toMatchObject({ flashAttn: 'toggle', nglKeywords: [], cacheTypes: [], fitFlag: false });
    expect(caps.version).toBeUndefined();
    expect(capsFromOutputs('', '--port PORT  port').flashAttn).toBe('none');
    expect(capsFromOutputs('', '--port PORT  port')).toMatchObject({ nglKeywords: [], cacheTypes: [] });
  });
});

describe('guessVariant', () => {
  it('reads the backend from the files next to the binary', () => {
    expect(guessVariant(['llama-server.exe', 'cudart64_13.dll', 'ggml-cuda.dll'])).toBe('cuda-13');
    expect(guessVariant(['libcudart.so.12.4.1'])).toBe('cuda-12');
    expect(guessVariant(['GGML-CUDA.DLL'])).toBe('cuda');
    expect(guessVariant(['libggml-vulkan.so'])).toBe('vulkan');
    expect(guessVariant(['llama-server'])).toBe('cpu');
  });
});

describe('CapsProbe', () => {
  function runner(help: RunOutput, version: RunOutput = { code: 0, stdout: '', stderr: VERSION, timedOut: false }) {
    const run = vi.fn(async (_cmd: string, args: string[], _opts?: unknown) => (args.includes('--help') ? help : version));
    const proc: ProcessRunner = { run, spawn: () => { throw new Error('unused'); } };
    return { proc, run };
  }

  it('runs --version/--help once per binary identity (path + size + mtime)', async () => {
    const { proc, run } = runner({ code: 0, stdout: HELP, stderr: '', timedOut: false });
    let mtimeMs = 1;
    const probe = new CapsProbe(proc, 5000, async () => ({ size: 10, mtimeMs }));
    const a = await probe.probe(['node', 'cli.mjs'], { X: '1' });
    const b = await probe.probe(['node', 'cli.mjs'], { X: '1' });
    expect(b).toBe(a);
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[0]?.slice(0, 2)).toEqual(['node', ['cli.mjs', '--version']]);
    expect(run.mock.calls[0]?.[2]).toEqual({ timeoutMs: 5000, env: { X: '1' } });
    const v = await probe.version(['node', 'cli.mjs']);
    expect(v).toMatchObject({ ok: true, build: 'b10997', code: 0 });
    mtimeMs = 2; // binary replaced
    await probe.probe(['node', 'cli.mjs']);
    expect(run).toHaveBeenCalledTimes(4);
  });

  it('a failing --help is an error and is not cached; a broken --version is ok:false', async () => {
    const { proc, run } = runner({ code: 1, stdout: '', stderr: 'error while loading shared libraries', timedOut: false }, {
      code: 127,
      stdout: '',
      stderr: 'libcudart.so.13: cannot open shared object file',
      timedOut: false,
    });
    const probe = new CapsProbe(proc);
    const v = await probe.version(['/missing/llama-server']);
    expect(v).toMatchObject({ ok: false, code: 127 });
    await expect(probe.probe(['/missing/llama-server'])).rejects.toMatchObject({ code: 'ENGINE_START_FAILED', params: { code: '1' } });
    await expect(probe.probe(['/missing/llama-server'])).rejects.toMatchObject({ code: 'ENGINE_START_FAILED' });
    expect(run.mock.calls.filter((c) => (c[1] as string[]).includes('--help'))).toHaveLength(2);
  });

  it('exit 0 without any option table is still a failure', async () => {
    const { proc } = runner({ code: 0, stdout: 'hello', stderr: '', timedOut: false });
    await expect(new CapsProbe(proc).probe(['x'])).rejects.toMatchObject({ code: 'ENGINE_START_FAILED' });
  });
});
