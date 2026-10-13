import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  addAppNotices,
  COPIED,
  ENGINES_COPY_LIMIT,
  finishLegacyMove,
  insideDir,
  legacyInUse,
  LIVE_STATE,
  moveLegacyData,
  movedNotice,
  movePaths,
  pidAlive,
  repairVenvScripts,
  sizeUpTo,
  type LegacyMove,
  type LegacyMoveHost,
} from '../../../src/main/migrate';
import { FakeFs, fsError } from './fake-fs';

/** %APPDATA% (or ~/.config) of a pretend user: GPU Bench's folder and LLM Bench's next to it. */
const ROOT = path.resolve('/appdata');
const OLD = path.join(ROOT, 'GPU Bench');
const NEW = path.join(ROOT, 'LLM Bench');
const at = (dir: string, ...p: string[]) => path.join(dir, ...p);

/** GPU Bench's data as 0.3.0 left it. */
function gpuBench(fs = new FakeFs()): FakeFs {
  return fs
    .file(at(OLD, 'settings.json'), JSON.stringify({ language: 'it', lastEngine: { kind: 'llamacpp-native', executable: at(OLD, 'engines', 'llamacpp', 'b1', 'llama-server.exe') } }))
    .file(at(OLD, 'results', 'r1.json'), '{"id":"r1"}')
    .file(at(OLD, 'hf-token.bin'), 'enc:hf_old')
    .file(at(OLD, 'server-api-key.bin'), 'enc:gpub-x')
    .file(at(OLD, 'shell.json'), '{"hideNoticeShown":true}')
    .file(at(OLD, 'downloads.json'), '[]')
    .file(at(OLD, 'processes.json'), '{"schema":1,"records":[]}')
    .file(at(OLD, 'ninfer-wsl.json'), '[]')
    .file(at(OLD, 'Local State'), '{"os_crypt":{"encrypted_key":"k"}}')
    .file(at(OLD, 'engines', 'llamacpp', 'b1', 'llama-server.exe'), 'MZ', 600 * 1024 ** 2)
    .dir(at(OLD, 'Cache'));
}

function host(fs: FakeFs, o: Partial<LegacyMoveHost> = {}): LegacyMoveHost {
  return { platform: 'win32', userData: NEW, legacy: OLD, fs, hostname: 'pc', kill: () => true, ...o };
}

/** The test's paths are this machine's: Windows rules here, POSIX ones on Linux. */
const NATIVE = process.platform === 'win32' ? 'win32' : 'linux';

function finishHost(fs: FakeFs, platform = NATIVE) {
  const warnings: string[] = [];
  return { h: { platform, fs, warn: (m: string) => void warnings.push(m) }, warnings };
}

describe('moveLegacyData: GPU Bench’s folder becomes LLM Bench’s, first thing at start', () => {
  it('renamed when LLM Bench has no data: missing, or the empty folder Electron just made', () => {
    const fs = gpuBench();
    expect(moveLegacyData(host(fs))).toEqual({ kind: 'moved', from: OLD, to: NEW });
    expect(fs.has(OLD)).toBe(false);
    expect(fs.text(at(NEW, 'results', 'r1.json'))).toBe('{"id":"r1"}');
    const empty = gpuBench().dir(NEW);
    expect(moveLegacyData(host(empty))).toMatchObject({ kind: 'moved' });
    expect(empty.calls).toContain(`rmdir ${NEW}`);
    expect(empty.text(at(NEW, 'Local State'))).toBe('{"os_crypt":{"encrypted_key":"k"}}');
  });

  it('nothing to do: LLM Bench already has its settings, or there is no GPU Bench', () => {
    const both = gpuBench().file(at(NEW, 'settings.json'), '{}');
    expect(moveLegacyData(host(both))).toEqual({ kind: 'none' });
    expect(both.has(OLD)).toBe(true);
    expect(moveLegacyData(host(new FakeFs()))).toEqual({ kind: 'none' });
  });

  it('GPU Bench open on Windows (its lockfile busy): copied later, the folder left as it is', () => {
    const fs = gpuBench().file(at(OLD, 'lockfile'), '');
    fs.busy.add(path.resolve(at(OLD, 'lockfile')));
    expect(moveLegacyData(host(fs))).toEqual({ kind: 'copy', from: OLD, to: NEW, inUse: true });
    expect(fs.has(at(OLD, 'settings.json'))).toBe(true);
    // The key of the secrets is there before Chromium reads it.
    expect(fs.text(at(NEW, 'Local State'))).toBe('{"os_crypt":{"encrypted_key":"k"}}');
    // A lockfile left behind by a crash opens fine: renamed.
    const stale = gpuBench().file(at(OLD, 'lockfile'), '');
    expect(moveLegacyData(host(stale)).kind).toBe('moved');
    expect(legacyInUse(host(new FakeFs()))).toBe(false);
  });

  it('Linux: SingletonLock names a live process of this PC (or another PC): copied; a dead one: renamed', () => {
    const linux = (fs: FakeFs, o: Partial<LegacyMoveHost> = {}) => host(fs, { platform: 'linux', ...o });
    const locked = () => gpuBench().link(at(OLD, 'SingletonLock'), 'pc-4242');
    expect(moveLegacyData(linux(locked()))).toMatchObject({ kind: 'copy', inUse: true });
    // Alive but someone else's process (EPERM): still running.
    const eperm = () => {
      throw fsError('EPERM', 'kill', '4242');
    };
    expect(moveLegacyData(linux(locked(), { kill: eperm }))).toMatchObject({ kind: 'copy', inUse: true });
    const esrch = () => {
      throw fsError('ESRCH', 'kill', '4242');
    };
    expect(moveLegacyData(linux(locked(), { kill: esrch })).kind).toBe('moved');
    expect(moveLegacyData(linux(locked(), { hostname: 'other' }))).toMatchObject({ kind: 'copy', inUse: true });
    expect(moveLegacyData(linux(gpuBench().link(at(OLD, 'SingletonLock'), 'garbage'))).kind).toBe('moved');
    expect(moveLegacyData(linux(gpuBench())).kind).toBe('moved');
    expect(pidAlive(() => true, 1)).toBe(true);
  });

  it('copied when the rename is not possible: something already in LLM Bench’s folder, or the OS refuses', () => {
    const busy = gpuBench().file(at(NEW, 'lockfile'), '').file(at(NEW, 'Local State'), '{"mine":1}');
    expect(moveLegacyData(host(busy))).toEqual({ kind: 'copy', from: OLD, to: NEW, inUse: false });
    // Its own Local State stays.
    expect(busy.text(at(NEW, 'Local State'))).toBe('{"mine":1}');
    const refused = gpuBench();
    refused.failures.set(`rename ${path.resolve(OLD)}`, 'EPERM');
    expect(moveLegacyData(host(refused))).toMatchObject({ kind: 'copy', inUse: false });
    expect(refused.has(NEW)).toBe(true);
    // No Local State in GPU Bench's folder: nothing to bring.
    const bare = new FakeFs().file(at(OLD, 'settings.json'), '{}').file(at(NEW, 'x'), '');
    expect(moveLegacyData(host(bare)).kind).toBe('copy');
    expect(bare.has(at(NEW, 'Local State'))).toBe(false);
  });

  it('never throws: anything unexpected leaves everything as it is', () => {
    const fs = gpuBench().file(at(NEW, 'lockfile'), '');
    fs.failures.set(`mkdir ${path.resolve(NEW)}`, 'EACCES');
    expect(moveLegacyData(host(fs))).toEqual({ kind: 'none' });
    expect(fs.has(at(OLD, 'settings.json'))).toBe(true);
  });
});

describe('finishLegacyMove: the copy, and the paths that follow the data', () => {
  it('moved: settings paths into GPU Bench’s folder point into LLM Bench’s; the venv scripts too', async () => {
    const fs = gpuBench();
    moveLegacyData(host(fs, { platform: 'linux' }));
    const venv = at(NEW, 'engines', 'vllm-venv');
    fs.file(at(venv, 'pyvenv.cfg'), 'home = /home/anna/.local/share/uv/python/bin')
      .file(at(venv, 'bin', 'vllm'), `#!/bin/sh\n'''exec' '${at(OLD, 'engines', 'vllm-venv', 'bin', 'python')}' "$0" "$@"\n' '''\n`)
      .file(at(venv, 'bin', 'activate'), `VIRTUAL_ENV='${at(OLD, 'engines', 'vllm-venv')}'\n`)
      .file(at(venv, 'bin', 'plain'), '#!/usr/bin/env python3\n')
      .file(at(venv, 'bin', 'big.so'), OLD, 2 * 1024 * 1024)
      .link(at(venv, 'bin', 'python'), '/home/anna/.local/share/uv/python/bin/python3')
      .dir(at(venv, 'bin', 'sub'))
      .file(at(NEW, 'engines', 'not-a-venv', 'bin', 'x'), OLD)
      .file(at(NEW, 'engines', 'llamacpp', 'b1', 'pyvenv.cfg.txt'), '');
    const { h } = finishHost(fs);
    const report = await finishLegacyMove(h, { kind: 'moved', from: OLD, to: NEW });
    expect(report).toEqual({ rewritten: 1, scripts: 2 });
    expect(JSON.parse(fs.text(at(NEW, 'settings.json'))!).lastEngine.executable).toBe(at(NEW, 'engines', 'llamacpp', 'b1', 'llama-server.exe'));
    expect(fs.text(at(venv, 'bin', 'vllm'))).toContain(`'${at(NEW, 'engines', 'vllm-venv', 'bin', 'python')}'`);
    expect(fs.text(at(venv, 'bin', 'activate'))).toBe(`VIRTUAL_ENV='${at(NEW, 'engines', 'vllm-venv')}'\n`);
    expect(fs.text(at(venv, 'bin', 'plain'))).toBe('#!/usr/bin/env python3\n');
    expect(fs.text(at(venv, 'bin', 'big.so'))).toBe(OLD);
    expect(fs.text(at(NEW, 'engines', 'not-a-venv', 'bin', 'x'))).toBe(OLD);
  });

  it('moved: settings without paths into the old folder, unreadable, or missing are left alone', async () => {
    const plain = new FakeFs().file(at(NEW, 'settings.json'), '{"language":"en","n":3,"x":null}');
    expect(await finishLegacyMove(finishHost(plain).h, { kind: 'moved', from: OLD, to: NEW })).toEqual({ rewritten: 0, scripts: 0 });
    expect(plain.text(at(NEW, 'settings.json'))).toBe('{"language":"en","n":3,"x":null}');
    const broken = new FakeFs().file(at(NEW, 'settings.json'), '{oops');
    expect((await finishLegacyMove(finishHost(broken).h, { kind: 'moved', from: OLD, to: NEW })).rewritten).toBe(0);
    expect((await finishLegacyMove(finishHost(new FakeFs()).h, { kind: 'moved', from: OLD, to: NEW })).rewritten).toBe(0);
  });

  it('copied while GPU Bench is open: data, secrets and small engines; never its live state', async () => {
    const fs = gpuBench();
    const move: LegacyMove = { kind: 'copy', from: OLD, to: NEW, inUse: true };
    const report = await finishLegacyMove(finishHost(fs).h, move);
    expect(report).toEqual({ rewritten: 1, scripts: 0 });
    for (const name of COPIED) expect(fs.has(at(NEW, name))).toBe(true);
    for (const name of LIVE_STATE) expect(fs.has(at(NEW, name))).toBe(false);
    expect(fs.has(at(NEW, 'Cache'))).toBe(false);
    expect(fs.text(at(NEW, 'engines', 'llamacpp', 'b1', 'llama-server.exe'))).toBe('MZ');
    // The copied settings name the copied engine; GPU Bench's folder is as it was.
    expect(JSON.parse(fs.text(at(NEW, 'settings.json'))!).lastEngine.executable).toBe(at(NEW, 'engines', 'llamacpp', 'b1', 'llama-server.exe'));
    expect(JSON.parse(fs.text(at(OLD, 'settings.json'))!).lastEngine.executable).toBe(at(OLD, 'engines', 'llamacpp', 'b1', 'llama-server.exe'));
  });

  it('copied with GPU Bench closed: its live state too; engines too large stay there (and so do the paths to them)', async () => {
    const fs = gpuBench()
      .file(at(OLD, 'engines', 'vllm-venv', 'lib', 'torch.so'), 'x', ENGINES_COPY_LIMIT)
      .file(at(NEW, 'results', 'r1.json'), '{"id":"r1","mine":true}');
    const report = await finishLegacyMove(finishHost(fs).h, { kind: 'copy', from: OLD, to: NEW, inUse: false });
    expect(report).toEqual({ enginesIn: at(OLD, 'engines'), rewritten: 0, scripts: 0 });
    for (const name of LIVE_STATE) expect(fs.has(at(NEW, name))).toBe(true);
    expect(fs.has(at(NEW, 'engines'))).toBe(false);
    expect(JSON.parse(fs.text(at(NEW, 'settings.json'))!).lastEngine.executable).toBe(at(OLD, 'engines', 'llamacpp', 'b1', 'llama-server.exe'));
    // Nothing already in LLM Bench's folder is overwritten.
    expect(fs.text(at(NEW, 'results', 'r1.json'))).toBe('{"id":"r1","mine":true}');
  });

  it('copied: missing pieces are skipped, a failing step is reported and the rest goes on', async () => {
    const fs = new FakeFs().file(at(OLD, 'settings.json'), '{}').file(at(OLD, 'results', 'a.json'), '{}');
    fs.failures.set(`cp ${path.resolve(at(OLD, 'settings.json'))}`, 'EACCES');
    const { h, warnings } = finishHost(fs);
    expect(await finishLegacyMove(h, { kind: 'copy', from: OLD, to: NEW, inUse: false })).toEqual({ rewritten: 0, scripts: 0 });
    expect(warnings).toEqual([expect.stringMatching(/^rename migration: copy settings\.json: Error: EACCES/)]);
    expect(fs.has(at(NEW, 'results', 'a.json'))).toBe(true);
    expect(fs.has(at(NEW, 'hf-token.bin'))).toBe(false);
  });

  it('a settings file that cannot be written is reported, the start goes on', async () => {
    const fs = gpuBench();
    moveLegacyData(host(fs));
    fs.failures.set(`writeFile ${path.resolve(at(NEW, 'settings.json'))}`, 'EBUSY');
    const { h, warnings } = finishHost(fs);
    expect(await finishLegacyMove(h, { kind: 'moved', from: OLD, to: NEW })).toEqual({ rewritten: 0, scripts: 0 });
    expect(warnings).toEqual([expect.stringMatching(/^rename migration: settings paths: Error: EBUSY/)]);
    // Same for a venv script.
    const venv = gpuBench();
    moveLegacyData(host(venv, { platform: 'linux' }));
    venv.file(at(NEW, 'engines', 'v', 'pyvenv.cfg'), '').file(at(NEW, 'engines', 'v', 'bin', 'x'), OLD);
    venv.failures.set(`writeFile ${path.resolve(at(NEW, 'engines', 'v', 'bin', 'x'))}`, 'EROFS');
    const second = finishHost(venv);
    expect((await finishLegacyMove(second.h, { kind: 'moved', from: OLD, to: NEW })).scripts).toBe(0);
    expect(second.warnings).toEqual([expect.stringMatching(/^rename migration: python environments: Error: EROFS/)]);
  });
});

describe('helpers', () => {
  it('insideDir: Windows paths without case and with either slash; POSIX exact', () => {
    expect(insideDir('C:\\Users\\a\\AppData\\Roaming\\GPU Bench\\engines', 'c:/users/a/appdata/roaming/gpu bench', 'win32')).toBe(true);
    expect(insideDir('C:\\x\\GPU Bench', 'C:\\x\\GPU Bench\\', 'win32')).toBe(true);
    expect(insideDir('C:\\x\\GPU Bench2\\a', 'C:\\x\\GPU Bench', 'win32')).toBe(false);
    expect(insideDir('/home/a/.config/GPU Bench/engines', '/home/a/.config/GPU Bench', 'linux')).toBe(true);
    expect(insideDir('/home/a/.config/gpu bench/engines', '/home/a/.config/GPU Bench', 'linux')).toBe(false);
  });

  it('movePaths: every string inside the folder, in arrays and objects, counted', () => {
    const count = { n: 0 };
    const moved = movePaths({ a: ['/c/GPU Bench/x', 1, true, null], b: { c: '/c/GPU Bench' }, d: '/c/other' }, '/c/GPU Bench/', '/c/LLM Bench', 'linux', count);
    expect(moved).toEqual({ a: ['/c/LLM Bench/x', 1, true, null], b: { c: '/c/LLM Bench' }, d: '/c/other' });
    expect(count.n).toBe(2);
  });

  it('sizeUpTo stops once past the limit; an unreadable folder counts as empty', async () => {
    const fs = new FakeFs().file(at(ROOT, 'e', 'a'), 'x', 10).file(at(ROOT, 'e', 'sub', 'b'), 'x', 10).file(at(ROOT, 'e', 'sub', 'c'), 'x', 10).link(at(ROOT, 'e', 'l'), 'abc');
    expect(await sizeUpTo(fs, at(ROOT, 'e'), 1000)).toBe(33);
    expect(await sizeUpTo(fs, at(ROOT, 'e'), 5)).toBeLessThan(33);
    expect(await sizeUpTo(fs, at(ROOT, 'missing'), 5)).toBe(0);
    // A file gone between the listing and its size: not counted.
    fs.failures.set(`lstat ${path.resolve(at(ROOT, 'e', 'a'))}`, 'ENOENT');
    expect(await sizeUpTo(fs, at(ROOT, 'e'), 1000)).toBe(23);
    expect(await repairVenvScripts(finishHost(fs).h, at(ROOT, 'missing'), OLD, NEW)).toBe(0);
    // A venv without bin/, a script gone while looking: nothing to repair.
    const venvs = new FakeFs().file(at(ROOT, 'eng', 'nobin', 'pyvenv.cfg'), '').file(at(ROOT, 'eng', 'v', 'pyvenv.cfg'), '').file(at(ROOT, 'eng', 'v', 'bin', 'gone'), OLD);
    venvs.failures.set(`lstat ${path.resolve(at(ROOT, 'eng', 'v', 'bin', 'gone'))}`, 'ENOENT');
    expect(await repairVenvScripts(finishHost(venvs).h, at(ROOT, 'eng'), OLD, NEW)).toBe(0);
  });

  it('the notice says what happened', () => {
    expect(movedNotice({ kind: 'moved', from: OLD, to: NEW }, { rewritten: 0, scripts: 0 })).toEqual({ id: 'data-moved', kind: 'data-moved', mode: 'moved', from: OLD });
    expect(movedNotice({ kind: 'copy', from: OLD, to: NEW, inUse: true }, { enginesIn: 'E', rewritten: 0, scripts: 0 })).toEqual({ id: 'data-moved', kind: 'data-moved', mode: 'copied', from: OLD, enginesIn: 'E' });
  });

  it('addAppNotices: added to what is there (same id replaced), nothing written for none', async () => {
    const fs = new FakeFs();
    const file = at(NEW, 'app-notices.json');
    await addAppNotices(fs, NEW, []);
    expect(fs.has(file)).toBe(false);
    await addAppNotices(fs, NEW, [{ id: 'data-moved', kind: 'data-moved', mode: 'copied', from: OLD }]);
    await addAppNotices(fs, NEW, [
      { id: 'data-moved', kind: 'data-moved', mode: 'moved', from: OLD },
      { id: 'secret-unreadable:hf-token', kind: 'secret-unreadable', secret: 'hf-token', renamed: true },
    ]);
    expect(JSON.parse(fs.text(file)!)).toEqual([
      { id: 'data-moved', kind: 'data-moved', mode: 'moved', from: OLD },
      { id: 'secret-unreadable:hf-token', kind: 'secret-unreadable', secret: 'hf-token', renamed: true },
    ]);
    // A damaged file is replaced, its invalid entries dropped.
    fs.file(file, '{oops');
    await addAppNotices(fs, NEW, [{ id: 'x', kind: 'secret-unreadable', secret: 'server-api-key', renamed: false }]);
    expect(JSON.parse(fs.text(file)!)).toHaveLength(1);
    fs.file(file, JSON.stringify([{ id: 'bad' }, { id: 'y', kind: 'secret-unreadable', secret: 'hf-token', renamed: false }]));
    await addAppNotices(fs, NEW, [{ id: 'x', kind: 'secret-unreadable', secret: 'server-api-key', renamed: false }]);
    expect(JSON.parse(fs.text(file)!).map((n: { id: string }) => n.id)).toEqual(['y', 'x']);
  });
});
