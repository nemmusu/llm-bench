import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { LocalModel } from '../../../../src/contract/models';
import { HashCache } from '../../../../src/core/models/hash';
import { readLocalGgufFacts } from '../../../../src/core/models/gguf';
import { modelIdFor } from '../../../../src/core/models/paths';
import { auxKindOf, DOWNLOAD_SIDECAR, knownLocations, ModelScanner, readSidecar, type ScannerOptions } from '../../../../src/core/models/scanner';
import type { ModelFactsEx } from '../../../../src/core/models/types';
import { llamaLikeGguf, writeGguf, writeSafetensors } from '../../../fixtures/gguf/writer';
import { memoryLogger, settingsWith, tempDir } from './helpers';

const PLATFORM = process.platform === 'win32' ? 'win32' : 'linux';

function canSymlink(): boolean {
  const t = tempDir('gb-symlink-probe-');
  try {
    writeFileSync(path.join(t.dir, 'a'), 'x');
    symlinkSync(path.join(t.dir, 'a'), path.join(t.dir, 'b'), 'file');
    return true;
  } catch {
    return false;
  } finally {
    t.cleanup();
  }
}
const SYMLINKS = canSymlink();

function gguf(file: string, opts: Parameters<typeof llamaLikeGguf>[0] = {}): string {
  return writeGguf(file, { ...llamaLikeGguf({ embd: 16, vocab: 8, ...opts }), totalSize: 8 * 1024 });
}

describe('pure helpers', () => {
  it('classifies auxiliary GGUF files by name', () => {
    expect(auxKindOf('mmproj-F16.gguf')).toBe('mmproj');
    expect(auxKindOf('Qwopus3.8-27B.mmproj-f16.gguf')).toBe('mmproj');
    expect(auxKindOf('mtp-gemma-4-31B-it.gguf')).toBe('mtp');
    expect(auxKindOf('model.mtp.gguf')).toBe('mtp');
    expect(auxKindOf('Qwen3-0.6B-draft-Q8_0.gguf')).toBe('draft');
    expect(auxKindOf('eagle3-gpt-oss-20b.gguf')).toBe('draft');
    expect(auxKindOf('gemma-4-31B-it-UD-Q4_K_XL.gguf')).toBeUndefined();
    expect(auxKindOf('smtpserver.gguf')).toBeUndefined();
  });

  it('lists known model folders per platform and env', () => {
    const win = knownLocations('win32', 'C:\\Users\\me', {});
    expect(win.map((r) => [r.dir, r.origin])).toEqual([
      ['C:\\models', 'custom'],
      ['C:\\Users\\me\\models', 'custom'],
      ['C:\\Users\\me\\.lmstudio\\models', 'lmstudio'],
      ['C:\\Users\\me\\.cache\\lm-studio\\models', 'lmstudio'],
      ['C:\\Users\\me\\.cache\\huggingface\\hub', 'hf-cache'],
      ['C:\\Users\\me\\.ollama\\models', 'ollama'],
    ]);
    expect(knownLocations('win32', 'C:\\Users\\me', { SystemDrive: 'D:' })[0]?.dir).toBe('D:\\models');
    const linux = knownLocations('linux', '/home/me', { HF_HOME: '/data/hf', OLLAMA_MODELS: '/data/ollama' });
    expect(linux.map((r) => r.dir)).toEqual([
      '/home/me/models',
      '/home/me/.lmstudio/models',
      '/home/me/.cache/lm-studio/models',
      '/data/hf/hub',
      '/data/ollama',
      '/usr/share/ollama/.ollama/models',
    ]);
    expect(knownLocations('darwin', '/Users/me', { HF_HUB_CACHE: '/x/hub' }).find((r) => r.origin === 'hf-cache')?.dir).toBe('/x/hub');
    expect(knownLocations('linux', '/h', { HUGGINGFACE_HUB_CACHE: '/legacy' }).find((r) => r.origin === 'hf-cache')?.dir).toBe('/legacy');
  });
});

describe('ModelScanner', () => {
  let t: ReturnType<typeof tempDir>;
  let log: ReturnType<typeof memoryLogger>;
  let library: string;
  let cacheDir: string;
  let home: string;

  beforeEach(() => {
    t = tempDir('gb-scan-');
    log = memoryLogger();
    library = path.join(t.dir, 'library');
    cacheDir = path.join(t.dir, 'cache');
    home = path.join(t.dir, 'home');
    mkdirSync(library, { recursive: true });
  });
  afterEach(() => t.cleanup());

  function scanner(patch: Parameters<typeof settingsWith>[0] = {}, extra: Partial<ScannerOptions> = {}): ModelScanner {
    // Known locations, but only those inside the temp dir (never C:\models or /usr/share/ollama).
    const env = extra.env ?? {};
    const knownRoots = knownLocations(PLATFORM, home, env).filter((r) => r.dir.startsWith(t.dir));
    return new ModelScanner({
      platform: PLATFORM,
      home,
      env,
      defaultModelsDir: library,
      cacheDir,
      log,
      settings: settingsWith(patch),
      knownRoots,
      ...extra,
    });
  }
  const byName = (models: LocalModel[], name: string) => models.find((m) => m.identity.displayName === name);

  it('finds library downloads with repo from the folder layout and sha256 from the sidecar', async () => {
    const repoDir = path.join(library, 'Qwen', 'Qwen3-4B-GGUF');
    const file = gguf(path.join(repoDir, 'Qwen3-4B-Q4_K_M.gguf'), { arch: 'qwen3', layers: 3 });
    const sha = createHash('sha256').update(readFileSync(file)).digest('hex');
    writeFileSync(path.join(repoDir, DOWNLOAD_SIDECAR), JSON.stringify({ repo: 'Qwen/Qwen3-4B-GGUF', revision: 'a'.repeat(40), files: { 'Qwen3-4B-Q4_K_M.gguf': { sha256: sha, sizeBytes: 8192 } } }));
    const models = await scanner().scan();
    expect(models).toHaveLength(1);
    const m = models[0] as LocalModel;
    expect(m).toMatchObject({
      id: modelIdFor(file, PLATFORM),
      origin: 'library',
      dir: repoDir,
      paths: [file],
      auxiliary: [],
      identity: {
        displayName: 'Qwen3-4B-Q4_K_M',
        format: 'gguf',
        source: 'hf',
        repo: 'Qwen/Qwen3-4B-GGUF',
        revision: 'a'.repeat(40),
        file: 'Qwen3-4B-Q4_K_M.gguf',
        files: ['Qwen3-4B-Q4_K_M.gguf'],
        quant: 'Q4_K_M',
        sizeBytes: 8192,
        sha256: sha,
        weakKey: 'Qwen/Qwen3-4B-GGUF/Qwen3-4B-Q4_K_M.gguf/Q4_K_M/8192',
        path: file,
      },
    });
    expect(m.identity.facts?.blockCount).toBe(3);
    expect(Date.parse(m.modifiedAt)).toBeGreaterThan(0);
  });

  it('ignores sidecar hashes of other sizes, broken sidecars and invalid repo folders', async () => {
    const repoDir = path.join(library, 'o', 'r');
    gguf(path.join(repoDir, 'm-Q8_0.gguf'));
    writeFileSync(path.join(repoDir, DOWNLOAD_SIDECAR), JSON.stringify({ repo: 'o/r', files: { 'm-Q8_0.gguf': { sha256: 'b'.repeat(64), sizeBytes: 1 } } }));
    gguf(path.join(library, 'p', 'q', 'n-Q8_0.gguf'));
    writeFileSync(path.join(library, 'p', 'q', DOWNLOAD_SIDECAR), JSON.stringify({ repo: 'p/q', files: { 'n-Q8_0.gguf': { sha256: 'c'.repeat(64) } } }));
    gguf(path.join(library, 'bad name', 'x y', 'z-Q8_0.gguf'));
    gguf(path.join(library, 'k', 'l', 'w-Q8_0.gguf'));
    writeFileSync(path.join(library, 'k', 'l', DOWNLOAD_SIDECAR), '{"files": 3}');
    gguf(path.join(library, 'loose-Q8_0.gguf'));
    const models = await scanner().scan();
    expect(byName(models, 'm-Q8_0')?.identity.sha256).toBeUndefined();
    expect(byName(models, 'm-Q8_0')?.identity.revision).toBeUndefined();
    expect(byName(models, 'n-Q8_0')?.identity.sha256).toBe('c'.repeat(64));
    expect(byName(models, 'z-Q8_0')?.identity.repo).toBeUndefined();
    expect(byName(models, 'w-Q8_0')?.identity.repo).toBe('k/l');
    expect(byName(models, 'loose-Q8_0')?.identity).toMatchObject({ source: 'local', weakKey: 'local/loose-Q8_0.gguf/Q8_0/8192' });
    expect(await readSidecar(path.join(library, 'nope'))).toBeUndefined();
  });

  it('groups complete split sets, skips partial ones, attaches mmproj / mtp / draft files', async () => {
    const dir = path.join(t.dir, 'custom', 'gemma');
    gguf(path.join(dir, 'gemma-4-x-UD-Q4_K_XL-00001-of-00002.gguf'), { arch: 'gemma4', layers: 2 });
    writeGguf(path.join(dir, 'gemma-4-x-UD-Q4_K_XL-00002-of-00002.gguf'), { metadata: { 'split.count': 2 }, totalSize: 4096 });
    gguf(path.join(dir, 'other-model-Q8_0.gguf'));
    gguf(path.join(dir, 'partial-Q8_0-00001-of-00003.gguf'));
    gguf(path.join(dir, 'gap-Q8_0-00001-of-00002.gguf'));
    gguf(path.join(dir, 'gap-Q8_0-00003-of-00002.gguf'));
    writeGguf(path.join(dir, 'mtp-gemma-4-x.gguf'), { metadata: { 'general.architecture': 'gemma4-assistant' } });
    writeGguf(path.join(dir, 'mmproj-F16.gguf'), { metadata: { 'general.architecture': 'clip' } });
    writeGguf(path.join(dir, 'other-model-draft-Q4_0.gguf'), { metadata: {} });
    writeFileSync(path.join(dir, 'notes.txt'), 'hi');
    const models = await scanner({ extraModelDirs: [path.join(t.dir, 'custom')] }).scan();
    expect(models.map((m) => m.identity.displayName).sort()).toEqual(['gemma-4-x-UD-Q4_K_XL', 'other-model-Q8_0']);
    const gemma = byName(models, 'gemma-4-x-UD-Q4_K_XL') as LocalModel;
    expect(gemma.identity.files).toEqual(['gemma-4-x-UD-Q4_K_XL-00001-of-00002.gguf', 'gemma-4-x-UD-Q4_K_XL-00002-of-00002.gguf']);
    expect(gemma.identity.sizeBytes).toBe(8192 + 4096);
    expect(gemma.identity.quant).toBe('UD-Q4_K_XL');
    expect(gemma.origin).toBe('custom');
    expect(gemma.auxiliary.map((a) => [a.kind, path.basename(a.path)]).sort()).toEqual([
      ['mmproj', 'mmproj-F16.gguf'],
      ['mtp', 'mtp-gemma-4-x.gguf'],
    ]);
    expect(gemma.paths.slice(0, 2).map((p) => path.basename(p))).toEqual(gemma.identity.files);
    const other = byName(models, 'other-model-Q8_0') as LocalModel;
    expect(other.auxiliary.map((a) => a.kind).sort()).toEqual(['draft', 'mmproj']);
    expect(log.entries.some((e) => e.msg === 'incomplete split GGUF skipped')).toBe(true);
  });

  it('demotes clip models without "mmproj" in the name and attaches orphan auxiliaries from sub-folders', async () => {
    const dir = path.join(library, 'unsloth', 'Demo-GGUF');
    gguf(path.join(dir, 'Demo-Q8_0.gguf'));
    writeGguf(path.join(dir, 'vision-encoder.gguf'), { metadata: { 'general.architecture': 'clip' } });
    writeGguf(path.join(dir, 'MTP', 'mtp-Demo-Q8_0.gguf'), { metadata: {} });
    gguf(path.join(dir, 'Q4_K_M', 'Demo-Q4_K_M-00001-of-00001.gguf'));
    // An auxiliary alone at the top of a scan root has nothing to attach to.
    const lonely = path.join(t.dir, 'lonely');
    writeGguf(path.join(lonely, 'mmproj-F16.gguf'), { metadata: {} });
    const models = await scanner({ extraModelDirs: [lonely] }).scan();
    const demo = byName(models, 'Demo-Q8_0') as LocalModel;
    expect(demo.auxiliary.map((a) => [a.kind, path.basename(a.path)]).sort()).toEqual([
      ['mmproj', 'vision-encoder.gguf'],
      ['mtp', 'mtp-Demo-Q8_0.gguf'],
    ]);
    const split = byName(models, 'Demo-Q4_K_M') as LocalModel;
    expect(split.identity.repo).toBe('unsloth/Demo-GGUF');
    expect(split.auxiliary).toEqual([]);
    expect(models).toHaveLength(2);
  });

  it('detects safetensors folders for vLLM (quantized ones without a param count)', async () => {
    const dir = path.join(library, 'Qwen', 'Qwen3-0.6B');
    writeFileSync(path.join(mkdirAll(dir), 'config.json'), JSON.stringify({ architectures: ['Qwen3ForCausalLM'], num_hidden_layers: 4, num_attention_heads: 8, num_key_value_heads: 2, head_dim: 64, torch_dtype: 'bfloat16' }));
    writeSafetensors(path.join(dir, 'model-00002-of-00002.safetensors'), { tensors: { b: { dtype: 'BF16', shape: [8, 8] } } });
    writeSafetensors(path.join(dir, 'model-00001-of-00002.safetensors'), { tensors: { a: { dtype: 'BF16', shape: [4, 4] } } });
    const awq = path.join(t.dir, 'custom', 'awq-model');
    writeFileSync(path.join(mkdirAll(awq), 'config.json'), JSON.stringify({ num_hidden_layers: 2, quantization_config: { quant_method: 'awq', bits: 4 } }));
    writeSafetensors(path.join(awq, 'model.safetensors'), { tensors: { q: { dtype: 'I32', shape: [4] } } });
    const broken = path.join(t.dir, 'custom', 'broken');
    writeFileSync(path.join(mkdirAll(broken), 'config.json'), '{nope');
    writeSafetensors(path.join(broken, 'model.safetensors'));
    // Sharded: complete per the index, incomplete (a shard still downloading), unreadable index.
    const sharded = (name: string, index: string, shards: string[]) => {
      const d = path.join(t.dir, 'custom', name);
      writeFileSync(path.join(mkdirAll(d), 'config.json'), '{"num_hidden_layers": 1}');
      writeFileSync(path.join(d, 'model.safetensors.index.json'), index);
      for (const sh of shards) writeSafetensors(path.join(d, sh));
    };
    const map = JSON.stringify({ weight_map: { a: 'model-00001-of-00002.safetensors', b: 'model-00002-of-00002.safetensors' } });
    sharded('complete', map, ['model-00001-of-00002.safetensors', 'model-00002-of-00002.safetensors']);
    sharded('partial', map, ['model-00001-of-00002.safetensors']);
    sharded('bad-index', '{', ['model-00001-of-00002.safetensors']);
    const configOnly = path.join(t.dir, 'custom', 'config-only');
    writeFileSync(path.join(mkdirAll(configOnly), 'config.json'), '{}');
    const models = await scanner({ extraModelDirs: [path.join(t.dir, 'custom')] }).scan();
    const qwen = models.find((m) => m.identity.repo === 'Qwen/Qwen3-0.6B') as LocalModel;
    expect(qwen).toMatchObject({
      id: modelIdFor(dir, PLATFORM),
      dir,
      identity: { displayName: 'Qwen/Qwen3-0.6B', format: 'safetensors', source: 'hf', file: 'model-00001-of-00002.safetensors', quant: 'BF16', path: dir },
    });
    expect(qwen.identity.files).toEqual(['model-00001-of-00002.safetensors', 'model-00002-of-00002.safetensors']);
    expect(qwen.identity.facts?.paramsB).toBe(0);
    expect(qwen.paths.at(-1)).toBe(path.join(dir, 'config.json'));
    const a = models.find((m) => m.identity.displayName === 'awq-model') as LocalModel;
    expect(a.identity).toMatchObject({ source: 'local', quant: 'AWQ-4bit' });
    expect(a.identity.facts?.paramsB).toBeUndefined();
    expect(models.some((m) => m.identity.displayName === 'broken')).toBe(false);
    expect(models.some((m) => m.identity.displayName === 'complete')).toBe(true);
    expect(models.some((m) => m.identity.displayName === 'partial')).toBe(false);
    expect(models.some((m) => m.identity.displayName === 'bad-index')).toBe(false);
    expect(log.entries.filter((e) => e.msg === 'incomplete safetensors model skipped')).toHaveLength(2);
    expect(log.entries.some((e) => e.msg === 'cannot read safetensors model')).toBe(true);
    // Unquantized + unknown dtype: no quant label.
    const plain = path.join(t.dir, 'custom', 'plain');
    writeFileSync(path.join(mkdirAll(plain), 'config.json'), '{"num_hidden_layers": 1}');
    writeSafetensors(path.join(plain, 'model.safetensors'));
    const again = await scanner({ extraModelDirs: [path.join(t.dir, 'custom')] }).scan();
    expect(again.find((m) => m.identity.displayName === 'plain')?.identity.quant).toBeUndefined();
  });

  it('reads the HF cache layout (repo, revision, blob sha256 through symlinks)', async () => {
    const hub = path.join(t.dir, 'hf', 'hub');
    const rev = 'c'.repeat(40);
    const snap = path.join(hub, 'models--unsloth--Tiny-GGUF', 'snapshots', rev);
    const blob = gguf(path.join(hub, 'models--unsloth--Tiny-GGUF', 'blobs', 'd'.repeat(64)));
    mkdirAll(snap);
    if (SYMLINKS) symlinkSync(blob, path.join(snap, 'Tiny-Q4_K_M.gguf'), 'file');
    else gguf(path.join(snap, 'Tiny-Q4_K_M.gguf'));
    gguf(path.join(hub, 'models--unsloth--Tiny-GGUF', 'refs-misplaced-Q8_0.gguf'));
    gguf(path.join(hub, 'models--broken', 'snapshots', 'x', 'b-Q8_0.gguf'));
    gguf(path.join(hub, 'stray-Q8_0.gguf'));
    gguf(path.join(hub, 'datasets--a--b', 'snapshots', 'x', 'ds-Q8_0.gguf'));
    const stSnap = path.join(hub, 'models--Qwen--Qwen3-0.6B', 'snapshots', rev);
    writeFileSync(path.join(mkdirAll(stSnap), 'config.json'), '{"num_hidden_layers": 2, "torch_dtype": "bfloat16"}');
    writeSafetensors(path.join(stSnap, 'model.safetensors'), { tensors: { w: { dtype: 'BF16', shape: [2, 2] } } });
    // Plain (non-sha) blob names behind a symlink are not hashes.
    if (SYMLINKS) {
      const plainBlob = gguf(path.join(t.dir, 'elsewhere', 'plain-blob'));
      symlinkSync(plainBlob, path.join(snap, 'Linked-Q8_0.gguf'), 'file');
    }
    const models = await scanner({ scanKnownLocations: true }, { env: { HF_HUB_CACHE: hub } }).scan();
    const tiny = byName(models, 'Tiny-Q4_K_M') as LocalModel;
    expect(tiny).toMatchObject({ origin: 'hf-cache', identity: { repo: 'unsloth/Tiny-GGUF', revision: rev, source: 'hf' } });
    if (SYMLINKS) {
      expect(tiny.identity.sha256).toBe('d'.repeat(64));
      expect(byName(models, 'Linked-Q8_0')?.identity.sha256).toBeUndefined();
    }
    expect(byName(models, 'refs-misplaced-Q8_0')?.identity).toMatchObject({ repo: 'unsloth/Tiny-GGUF' });
    expect(byName(models, 'refs-misplaced-Q8_0')?.identity.revision).toBeUndefined();
    expect(byName(models, 'b-Q8_0')?.identity.repo).toBeUndefined();
    expect(byName(models, 'stray-Q8_0')?.identity.repo).toBeUndefined();
    expect(byName(models, 'ds-Q8_0')).toBeUndefined();
    expect(models.find((m) => m.identity.format === 'safetensors')?.identity).toMatchObject({ repo: 'Qwen/Qwen3-0.6B', revision: rev, displayName: 'Qwen/Qwen3-0.6B' });
  });

  it('uses huggingface-cli --local-dir metadata for sha256 and revision when fresh', async () => {
    const dir = path.join(t.dir, 'models');
    const file = gguf(path.join(dir, 'sub', 'Local-Q4_K_M.gguf'));
    const meta = path.join(dir, '.cache', 'huggingface', 'download', 'sub', 'Local-Q4_K_M.gguf.metadata');
    mkdirAll(path.dirname(meta));
    writeFileSync(meta, `${'e'.repeat(40)}\n${'f'.repeat(64)}\n${Date.now() / 1000 + 10}\n`);
    const stale = gguf(path.join(dir, 'Stale-Q4_K_M.gguf'));
    writeFileSync(path.join(dir, '.cache', 'huggingface', 'download', 'Stale-Q4_K_M.gguf.metadata'), `${'e'.repeat(40)}\n${'1'.repeat(64)}\n1000\n`);
    gguf(path.join(dir, 'NoCommit-Q4_K_M.gguf'));
    writeFileSync(path.join(dir, '.cache', 'huggingface', 'download', 'NoCommit-Q4_K_M.gguf.metadata'), `\n${'2'.repeat(64)}\n${Date.now() / 1000 + 10}\n`);
    gguf(path.join(dir, 'NotSha-Q4_K_M.gguf'));
    writeFileSync(path.join(dir, '.cache', 'huggingface', 'download', 'NotSha-Q4_K_M.gguf.metadata'), `${'e'.repeat(40)}\n"etag"\n${Date.now() / 1000 + 10}\n`);
    const models = await scanner({ extraModelDirs: [dir] }).scan();
    expect(byName(models, 'Local-Q4_K_M')?.identity).toMatchObject({ sha256: 'f'.repeat(64), revision: 'e'.repeat(40) });
    expect(byName(models, 'Stale-Q4_K_M')?.identity.sha256).toBeUndefined();
    expect(byName(models, 'NoCommit-Q4_K_M')?.identity).toMatchObject({ sha256: '2'.repeat(64) });
    expect(byName(models, 'NoCommit-Q4_K_M')?.identity.revision).toBeUndefined();
    expect(byName(models, 'NotSha-Q4_K_M')?.identity.sha256).toBeUndefined();
    expect(file).toBeTruthy();
    expect(stale).toBeTruthy();
  });

  it('uses the hash cache for files hashed earlier', async () => {
    const file = gguf(path.join(library, 'x-Q8_0.gguf'));
    const hashCache = new HashCache(path.join(cacheDir, 'hashes.json'), PLATFORM);
    const { statSync } = await import('node:fs');
    const st = statSync(file);
    await hashCache.set(file, st.size, st.mtimeMs, '9'.repeat(64));
    const models = await scanner({}, { hashCache }).scan();
    expect(models[0]?.identity.sha256).toBe('9'.repeat(64));
  });

  it('reads Ollama manifests (library, namespaced, hf.co) and projector blobs', async () => {
    const root = path.join(home, '.ollama', 'models');
    const blob = (hex: string, file?: string) => {
      const p = path.join(root, 'blobs', `sha256-${hex}`);
      if (file) gguf(p);
      else writeGguf(p, { metadata: { 'general.architecture': 'clip' } });
      return hex;
    };
    const model = blob('1'.repeat(64), 'gguf');
    const proj = blob('2'.repeat(64));
    const manifest = (rel: string, layers: unknown) => {
      const p = path.join(root, 'manifests', ...rel.split('/'));
      mkdirAll(path.dirname(p));
      writeFileSync(p, typeof layers === 'string' ? layers : JSON.stringify({ layers }));
    };
    manifest('registry.ollama.ai/library/qwen3/8b', [
      { mediaType: 'application/vnd.ollama.image.model', digest: `sha256:${model}` },
      { mediaType: 'application/vnd.ollama.image.projector', digest: `sha256:${proj}` },
    ]);
    manifest('registry.ollama.ai/someone/custom/latest', [{ mediaType: 'application/vnd.ollama.image.model', digest: `sha256:${model}` }]);
    manifest('hf.co/unsloth/Qwen3-4B-GGUF/Q4_K_M', [{ mediaType: 'application/vnd.ollama.image.model', digest: `sha256:${model}` }]);
    manifest('example.com/ns/thing/v1', [{ mediaType: 'application/vnd.ollama.image.model', digest: `sha256:${model}` }]);
    manifest('registry.ollama.ai/library/missing/1b', [{ mediaType: 'application/vnd.ollama.image.model', digest: `sha256:${'3'.repeat(64)}` }]);
    manifest('registry.ollama.ai/library/nolayers/1b', { layers: 'nope' } as unknown);
    writeFileSync(path.join(root, 'manifests', 'registry.ollama.ai', 'library', 'nolayers', '1b'), JSON.stringify({ layers: 'nope' }));
    manifest('registry.ollama.ai/library/badjson/1b', '{');
    manifest('registry.ollama.ai/library/baddigest/1b', [{ mediaType: 'application/vnd.ollama.image.model', digest: 'md5:xyz' }]);
    manifest('stray-file', []);
    writeFileSync(path.join(root, 'blobs', `sha256-${'4'.repeat(64)}`), 'not a gguf');
    manifest('registry.ollama.ai/library/junk/latest', [{ mediaType: 'application/vnd.ollama.image.model', digest: `sha256:${'4'.repeat(64)}` }]);
    const models = await scanner({ scanKnownLocations: true }, { env: {} }).scan();
    const ollama = models.filter((m) => m.origin === 'ollama');
    // Same names `ollama list` shows.
    expect(ollama.map((m) => m.identity.displayName).sort()).toEqual(['example.com/ns/thing:v1', 'hf.co/unsloth/Qwen3-4B-GGUF:Q4_K_M', 'junk:latest', 'qwen3:8b', 'someone/custom:latest']);
    const junk = ollama.find((m) => m.identity.displayName === 'junk:latest') as LocalModel;
    expect(junk.identity.facts).toBeUndefined();
    expect(junk.identity.quant).toBeUndefined();
    const q = ollama.find((m) => m.identity.displayName === 'qwen3:8b') as LocalModel;
    expect(q).toMatchObject({ identity: { sha256: model, format: 'gguf', source: 'local', quant: 'Q4_K_M' }, auxiliary: [{ kind: 'mmproj' }] });
    expect(q.paths).toHaveLength(2);
    const hf = ollama.find((m) => m.identity.displayName.startsWith('hf.co/')) as LocalModel;
    expect(hf.identity).toMatchObject({ repo: 'unsloth/Qwen3-4B-GGUF', source: 'hf', quant: 'Q4_K_M' });
    // One blob, several tags: each manifest is its own model.
    expect(new Set(ollama.map((m) => m.id)).size).toBe(5);
  });

  it('skips hidden, ignored and too-deep folders; never loops on links; stops at the entry budget', async () => {
    gguf(path.join(library, '.cache', 'hidden-Q8_0.gguf'));
    gguf(path.join(library, 'node_modules', 'nm-Q8_0.gguf'));
    writeFileSync(path.join(library, 'dl-Q8_0.gguf.part'), 'x');
    writeFileSync(path.join(library, 'dl-Q8_0.gguf.incomplete'), 'x');
    gguf(path.join(library, 'a', 'b', 'c', 'd', 'e', 'f', 'deep-Q8_0.gguf'));
    gguf(path.join(library, 'a', 'b', 'c', 'd', 'e', 'ok-Q8_0.gguf'));
    symlinkSync(library, path.join(library, 'a', 'loop'), 'junction');
    symlinkSync(path.join(t.dir, 'nowhere'), path.join(library, 'broken-link'), 'junction');
    const models = await scanner().scan();
    expect(models.map((m) => m.identity.displayName)).toEqual(['ok-Q8_0']);
    const small = await scanner({}, { maxEntries: 2 }).scan();
    expect(small.length).toBeLessThanOrEqual(1);
    expect(log.entries.some((e) => e.msg.startsWith('model scan stopped early'))).toBe(true);
  });

  it('dedupes roots and models seen through several roots; skips missing roots and files as roots', async () => {
    gguf(path.join(library, 'x-Q8_0.gguf'));
    const asFile = path.join(t.dir, 'a-file');
    writeFileSync(asFile, 'x');
    const s = scanner({ extraModelDirs: [library, path.join(library, '..', 'library'), path.join(t.dir, 'missing'), asFile] });
    expect((await s.roots()).map((r) => r.origin)).toEqual(['library', 'custom', 'custom']);
    const models = await s.scan();
    expect(models).toHaveLength(1);
    // The library is also visible through a link elsewhere: listed once.
    symlinkSync(library, path.join(t.dir, 'alias'), 'junction');
    expect(await scanner({ extraModelDirs: [path.join(t.dir, 'alias')] }).scan()).toHaveLength(1);
    expect(await scanner({ modelsDir: path.join(t.dir, 'custom-lib') }).libraryDir()).toBe(path.join(t.dir, 'custom-lib'));
    expect(await scanner().libraryDir()).toBe(library);
  });

  it('caches facts by path + size + mtime, invalidates on change, prunes unused entries', async () => {
    const file = gguf(path.join(library, 'c-Q8_0.gguf'), { layers: 2 });
    const calls: string[][] = [];
    const reader = async (paths: string[]): Promise<ModelFactsEx> => {
      calls.push(paths);
      return readLocalGgufFacts(paths);
    };
    expect((await scanner({}, { readGgufFacts: reader }).scan())[0]?.identity.facts?.blockCount).toBe(2);
    await scanner({}, { readGgufFacts: reader }).scan();
    expect(calls).toHaveLength(1);
    utimesSync(file, new Date(), new Date(Date.now() + 10_000));
    await scanner({}, { readGgufFacts: reader }).scan();
    expect(calls).toHaveLength(2);
    const cacheFile = path.join(cacheDir, 'model-facts.json');
    const before = JSON.parse(readFileSync(cacheFile, 'utf8')) as { entries: Record<string, unknown> };
    expect(Object.keys(before.entries)).toHaveLength(1);
    // Version bump → recomputed.
    writeFileSync(cacheFile, JSON.stringify({ version: 0, entries: before.entries }));
    await scanner({}, { readGgufFacts: reader }).scan();
    expect(calls).toHaveLength(3);
    writeFileSync(cacheFile, JSON.stringify({ version: 3, entries: null }));
    await scanner({}, { readGgufFacts: reader }).scan();
    expect(calls).toHaveLength(4);
  });

  it('lists unreadable GGUF files without facts and survives an unwritable cache', async () => {
    writeFileSync(path.join(library, 'junk-Q8_0.gguf'), 'not a gguf');
    gguf(path.join(library, 'fine-Q8_0.gguf'));
    writeFileSync(path.join(t.dir, 'cache-is-a-file'), 'x');
    const models = await scanner({}, { cacheDir: path.join(t.dir, 'cache-is-a-file') }).scan();
    const junk = byName(models, 'junk-Q8_0') as LocalModel;
    expect(junk.identity.facts).toBeUndefined();
    expect(junk.identity.quant).toBe('Q8_0');
    expect(log.entries.some((e) => e.msg === 'cannot read model metadata')).toBe(true);
    expect(log.entries.some((e) => e.msg === 'cannot write model facts cache')).toBe(true);
    // A GGUF without a quant in its name or header.
    writeGguf(path.join(library, 'plain.gguf'), { metadata: { 'general.architecture': 'llama' } });
    const again = await scanner({}, { cacheDir: path.join(t.dir, 'c2') }).scan();
    expect(again.find((m) => m.identity.displayName === 'plain')?.identity.quant).toBeUndefined();
  });

  it('LM Studio folders give the publisher/repo', async () => {
    const lm = path.join(home, '.lmstudio', 'models', 'lmstudio-community', 'Qwen3-4B-GGUF');
    gguf(path.join(lm, 'Qwen3-4B-Q4_K_M.gguf'));
    const models = await scanner({ scanKnownLocations: true }).scan();
    expect(models.find((m) => m.origin === 'lmstudio')?.identity.repo).toBe('lmstudio-community/Qwen3-4B-GGUF');
  });

  it('uses the built-in known locations when none are injected', async () => {
    // SystemDrive / home point into the temp dir, so nothing outside it is read on Windows.
    const drive = path.join(t.dir, 'drive');
    gguf(path.join(drive, 'models', 'sys-Q8_0.gguf'));
    const s = new ModelScanner({ platform: PLATFORM, home, env: { SystemDrive: drive, OLLAMA_MODELS: path.join(t.dir, 'ollama') }, defaultModelsDir: library, cacheDir, log, settings: settingsWith({ scanKnownLocations: true }) });
    const roots = await s.roots();
    expect(roots.some((r) => r.origin === 'hf-cache')).toBe(true);
    const models = await s.scan();
    if (PLATFORM === 'win32') expect(models.map((m) => m.identity.displayName)).toEqual(['sys-Q8_0']);
    expect(os.homedir()).toBeTruthy();
  });
});

function mkdirAll(dir: string): string {
  mkdirSync(dir, { recursive: true });
  return dir;
}
