/**
 * A fake git (answers from a state object), a fake cmake and fake uv for the engine update tests:
 * `run` answers like the real tools, `spawn` plays the lines a pull or a build prints.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { ExitInfo, ManagedProcess, RunOutput, SpawnSpec } from '../../../../../src/core/deps';
import { fail, manualProcess, ok, scriptedProc, tempDir } from '../../docker/helpers';

export interface FakeGitState {
  /** No git at all (spawn ENOENT). */
  missing?: boolean;
  head?: string;
  branch?: string;
  upstream?: string | null;
  upstreamHead?: string;
  changed?: number;
  behind?: number;
  ahead?: number;
  fetchFails?: string;
  /** Lines and exit code of `git pull` and `cmake --build` (spawned). */
  pull?: { lines: string[]; code: number | null };
  build?: { lines: string[]; code: number | null };
  cmakeMissing?: boolean;
}

/** A process that prints `lines` and exits with `code`. */
export function played(lines: readonly string[], code: number | null = 0): ManagedProcess {
  const mp = manualProcess();
  for (const l of lines) mp.push(l);
  const exit: ExitInfo = { code, signal: null };
  mp.exit(exit);
  return mp;
}

export function fakeTools(s: FakeGitState) {
  const answer = (args: string[], cmd: string): RunOutput => {
    if (cmd === 'cmake') return s.cmakeMissing ? fail(null, 'Error: spawn cmake ENOENT') : ok('cmake version 3.31.0\n');
    if (s.missing) return fail(null, 'Error: spawn git ENOENT');
    const a = args.slice(2).join(' ');
    if (a === 'rev-parse --short HEAD') return ok(`${s.head ?? 'a1b2c3d'}\n`);
    if (a === 'rev-parse --abbrev-ref HEAD') return ok(`${s.branch ?? 'master'}\n`);
    if (a === 'rev-parse --abbrev-ref --symbolic-full-name @{u}') return s.upstream === null ? fail(128, 'fatal: no upstream configured') : ok(`${s.upstream ?? 'origin/master'}\n`);
    if (a === 'fetch --quiet') return s.fetchFails ? fail(128, s.fetchFails) : ok();
    if (a === 'status --porcelain --untracked-files=no') return ok(Array.from({ length: s.changed ?? 0 }, (_, i) => ` M src/f${i}.cpp`).join('\n'));
    if (a === 'rev-list --count HEAD..@{u}') return ok(`${s.behind ?? 0}\n`);
    if (a === 'rev-list --count @{u}..HEAD') return ok(`${s.ahead ?? 0}\n`);
    if (a === 'rev-parse --short @{u}') return ok(`${s.upstreamHead ?? 'e4f5a6b'}\n`);
    return fail(1, `unexpected git ${a}`);
  };
  const proc = scriptedProc(
    (args, cmd) => answer(args, cmd),
    (spec: SpawnSpec) => {
      if (spec.cmd === 'git') return s.missing ? played(['Error: spawn git ENOENT'], null) : played(s.pull?.lines ?? ['Updating a1b2c3d..e4f5a6b', 'Fast-forward'], s.pull ? s.pull.code : 0);
      return s.cmakeMissing ? played(['Error: spawn cmake ENOENT'], null) : played(s.build?.lines ?? ['[ 50%] Building CXX object x.o', '[100%] Linking CXX executable bin/llama-server'], s.build ? s.build.code : 0);
    },
  );
  return { proc, git: ['git'], cmake: ['cmake'] };
}

/**
 * A checkout on disk: <dir>/llama.cpp/.git and <dir>/llama.cpp/build/bin/llama-server, with the
 * build's CMakeCache.txt naming its sources (optionally a multi-config generator).
 */
export function checkoutOnDisk(o: { multiConfig?: boolean | string; exeDir?: string; homeDirectory?: boolean } = {}) {
  const t = tempDir('gb-upd-');
  const repo = path.join(t.dir, 'llama.cpp');
  const build = path.join(repo, 'build');
  const bin = path.join(build, 'bin', ...(o.exeDir !== undefined ? [o.exeDir] : []));
  mkdirSync(path.join(repo, '.git'), { recursive: true });
  mkdirSync(bin, { recursive: true });
  const lines = [o.homeDirectory === false ? '' : `CMAKE_HOME_DIRECTORY:INTERNAL=${repo.replace(/\\/g, '/')}`, ...(o.multiConfig ? [`CMAKE_CONFIGURATION_TYPES:STRING=${o.multiConfig === true ? 'Debug;Release;RelWithDebInfo' : o.multiConfig}`] : [])];
  writeFileSync(path.join(build, 'CMakeCache.txt'), lines.join('\n'));
  const exe = path.join(bin, 'llama-server');
  writeFileSync(exe, '');
  return { ...t, repo, build, exe };
}
