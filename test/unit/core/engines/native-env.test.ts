import { promises as fsp, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ServerEvent } from '../../../../src/contract/events';
import type { NativeEnvKind } from '../../../../src/contract/native-envs';
import type { CoreContext } from '../../../../src/core/context';
import { createNativeEnvRoutes } from '../../../../src/core/engines/native-env/routes';
import { folderSize, NativeEnvs, parseNativeEnvKind, trackInstalls, type NativeEnvsDeps } from '../../../../src/core/engines/native-env/service';
import { errorResponse } from '../../../../src/core/server/http-error';

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(path.join(os.tmpdir(), 'gb-nenv-'));
  dirs.push(d);
  return d;
};

afterEach(() => {
  vi.restoreAllMocks();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** An engines dir with a vLLM environment (two files, 3 + 5 bytes) and a llama.cpp build beside it. */
function enginesDir(): string {
  const root = tmp();
  mkdirSync(path.join(root, 'vllm-venv', 'bin'), { recursive: true });
  writeFileSync(path.join(root, 'vllm-venv', 'pyvenv.cfg'), 'abc');
  writeFileSync(path.join(root, 'vllm-venv', 'bin', 'vllm'), '12345');
  mkdirSync(path.join(root, 'llamacpp', 'b1'), { recursive: true });
  writeFileSync(path.join(root, 'llamacpp', 'b1', 'llama-server'), 'x');
  return root;
}

function envs(root: string, over: Partial<NativeEnvsDeps> & { last?: Record<string, unknown> } = {}) {
  const { last, ...rest } = over;
  return new NativeEnvs({
    platform: 'linux',
    enginesDir: root,
    settings: { get: async () => ({ ...(last ? { lastEngine: last as never } : {}) }) },
    busy: () => false,
    ...rest,
  });
}

describe('native environments: plan', () => {
  it('names the two engines only', () => {
    expect(parseNativeEnvKind('vllm-native')).toBe('vllm-native');
    expect(parseNativeEnvKind('sglang-native')).toBe('sglang-native');
    expect(() => parseNativeEnvKind('llamacpp-native')).toThrow(expect.objectContaining({ code: 'VALIDATION' }));
  });

  it('the folder, its size and files; nothing there; not on Windows', async () => {
    const root = enginesDir();
    expect(await envs(root).plan('vllm-native')).toEqual({
      kind: 'vllm-native',
      supported: true,
      installed: true,
      folder: path.join(root, 'vllm-venv'),
      sizeBytes: 8,
      files: 2,
      busy: false,
    });
    expect(await envs(root).plan('sglang-native')).toEqual({
      kind: 'sglang-native',
      supported: true,
      installed: false,
      folder: path.join(root, 'sglang-venv'),
      sizeBytes: 0,
      files: 0,
      busy: false,
    });
    expect(await envs(root, { platform: 'win32' }).plan('vllm-native')).toMatchObject({ supported: false, installed: false, sizeBytes: 0 });
  });

  it("the user's own environment is named, one inside LLM Bench's folder is LLM Bench's", async () => {
    const root = enginesDir();
    const mine = path.join(tmp(), 'venv');
    expect((await envs(root, { last: { kind: 'vllm-native', vllmPath: mine } }).plan('vllm-native')).own).toBe(mine);
    expect((await envs(root, { last: { kind: 'sglang-native', sglangPath: mine } }).plan('sglang-native')).own).toBe(mine);
    expect((await envs(root, { last: { kind: 'vllm-native', vllmPath: path.join(root, 'vllm-venv', 'bin', 'vllm') } }).plan('vllm-native')).own).toBeUndefined();
    expect((await envs(root, { last: { kind: 'vllm-native', vllmPath: path.join(root, 'vllm-venv') } }).plan('vllm-native')).own).toBeUndefined();
    // Another engine's choice, a custom engine's, or none.
    expect((await envs(root, { last: { kind: 'sglang-native', sglangPath: mine } }).plan('vllm-native')).own).toBeUndefined();
    expect((await envs(root, { last: { kind: 'vllm-native', vllmPath: mine, customEngineId: 'c1' } }).plan('vllm-native')).own).toBeUndefined();
    expect((await envs(root, { last: { kind: 'vllm-native' } }).plan('vllm-native')).own).toBeUndefined();
  });

  it('busy while a benchmark, a server or an install of it runs', async () => {
    const root = enginesDir();
    expect((await envs(root, { busy: () => true }).plan('vllm-native')).busy).toBe(true);
    expect((await envs(root, { installing: (k) => k === 'vllm-native' }).plan('vllm-native')).busy).toBe(true);
    expect((await envs(root, { installing: (k) => k === 'vllm-native' }).plan('sglang-native')).busy).toBe(false);
  });
});

describe('native environments: size', () => {
  it('counts files in nested folders, a link as a link (never what it points to), nothing for a missing folder', async () => {
    const root = enginesDir();
    const outside = tmp();
    writeFileSync(path.join(outside, 'big'), 'x'.repeat(1000));
    // A junction on Windows, a symlink elsewhere: a link to a folder outside, like bin/python to uv's Python.
    symlinkSync(outside, path.join(root, 'vllm-venv', 'python'), 'junction');
    const size = await folderSize(path.join(root, 'vllm-venv'));
    expect(size.files).toBe(3);
    expect(size.bytes).toBeLessThan(1000);
    expect(await folderSize(path.join(root, 'nope'))).toEqual({ bytes: 0, files: 0 });
  });

  it('a file gone while it is read counts nothing', async () => {
    const root = enginesDir();
    vi.spyOn(fsp, 'lstat').mockRejectedValue(Object.assign(new Error('gone'), { code: 'ENOENT' }));
    expect(await folderSize(path.join(root, 'vllm-venv'))).toEqual({ bytes: 0, files: 0 });
  });
});

describe('native environments: removal', () => {
  it("deletes LLM Bench's folder only: the link's target, llama.cpp and the rest stay", async () => {
    const root = enginesDir();
    const outside = tmp();
    writeFileSync(path.join(outside, 'keep'), 'k');
    symlinkSync(outside, path.join(root, 'vllm-venv', 'python'), 'junction');
    await envs(root).remove('vllm-native');
    expect(existsSync(path.join(root, 'vllm-venv'))).toBe(false);
    expect(existsSync(path.join(outside, 'keep'))).toBe(true);
    expect(existsSync(path.join(root, 'llamacpp', 'b1', 'llama-server'))).toBe(true);
    expect((await envs(root).plan('vllm-native')).installed).toBe(false);
  });

  it('refused: not on Linux, busy, not there', async () => {
    const root = enginesDir();
    await expect(envs(root, { platform: 'win32' }).remove('vllm-native')).rejects.toMatchObject({ code: 'VALIDATION', params: { reason: 'unsupported-os' } });
    await expect(envs(root, { busy: () => true }).remove('vllm-native')).rejects.toMatchObject({ code: 'ENGINE_IN_USE', params: { engine: 'vLLM' } });
    await expect(envs(root, { installing: () => true }).remove('sglang-native')).rejects.toMatchObject({ code: 'ENGINE_IN_USE', params: { engine: 'SGLang' } });
    await expect(envs(root).remove('sglang-native')).rejects.toMatchObject({ code: 'ENGINE_NOT_INSTALLED', params: { kind: 'sglang-native' } });
    expect(existsSync(path.join(root, 'vllm-venv', 'bin', 'vllm'))).toBe(true);
  });

  it('one removal at a time: busy while it deletes, free again after (also when it fails)', async () => {
    const root = enginesDir();
    const e = envs(root);
    let release!: (err?: Error) => void;
    vi.spyOn(fsp, 'rm').mockImplementation(() => new Promise<void>((res, rej) => (release = (err) => (err ? rej(err) : res()))));
    const first = e.remove('vllm-native');
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    expect((await e.plan('vllm-native')).busy).toBe(true);
    await expect(e.remove('vllm-native')).rejects.toMatchObject({ code: 'ENGINE_IN_USE' });
    release(new Error('EACCES'));
    await expect(first).rejects.toThrow('EACCES');
    expect((await e.plan('vllm-native')).busy).toBe(false);
  });
});

describe('native environments: installs in progress', () => {
  it("from an install's or an update's first event to its end", () => {
    let listener!: (e: ServerEvent) => void;
    const installing = trackInstalls((l) => (listener = l));
    const ev = (kind: string, stage: string): ServerEvent => ({ type: 'engine.install', kind, stage, bytesDone: 0 });
    const is = (k: NativeEnvKind) => installing(k);
    listener(ev('vllm-native', 'resolve'));
    listener({ type: 'runs.changed' });
    expect(is('vllm-native')).toBe(true);
    expect(is('sglang-native')).toBe(false);
    listener(ev('vllm-native', 'done'));
    expect(is('vllm-native')).toBe(false);
    listener(ev('update:sglang-native', 'download'));
    expect(is('sglang-native')).toBe(true);
    listener(ev('update:sglang-native', 'error'));
    expect(is('sglang-native')).toBe(false);
  });
});

describe('native environments: API', () => {
  it('plan, removal, unknown engines refused', async () => {
    const removed: string[] = [];
    const app = new Hono();
    app.onError((e, c) => errorResponse(c, e));
    createNativeEnvRoutes({
      plan: async (kind) => ({ kind, supported: true, installed: true, folder: `/e/${kind}`, sizeBytes: 1, files: 1, busy: false }),
      remove: async (kind) => {
        removed.push(kind);
      },
    })(app, {} as CoreContext);
    expect(await (await app.request('/api/engines/sglang-native/environment')).json()).toMatchObject({ kind: 'sglang-native', folder: '/e/sglang-native' });
    expect(await (await app.request('/api/engines/vllm-native/environment', { method: 'DELETE' })).json()).toEqual({ ok: true });
    expect(removed).toEqual(['vllm-native']);
    const bad = await app.request('/api/engines/llamacpp-native/environment', { method: 'DELETE' });
    expect(bad.status).toBe(400);
    expect(removed).toEqual(['vllm-native']);
  });
});
