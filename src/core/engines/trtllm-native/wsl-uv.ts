/**
 * A Linux uv for the TensorRT-LLM environment inside a WSL distro: the official release for Linux
 * (astral-sh/uv), downloaded, checked against its .sha256 and unpacked by LLM Bench itself on this PC's
 * disk (enginesDir/wsl/uv/<version>/uv), then run by the distro through /mnt/<drive>. Nothing is piped
 * into a shell and nothing else of the distro changes. Its smoke test (`uv --version`) runs in the distro.
 */
import path from 'node:path';
import type { CoreDeps, ProcessRunner } from '../../deps';
import { UvInstaller } from '../../setup/uv';
import { distroRunner, wslPathOf } from '../ninfer/wsl';
import type { ProgressSink } from '../types';

export interface WslUvOptions {
  deps: Pick<CoreDeps, 'fetch' | 'proc' | 'clock' | 'arch' | 'paths' | 'appVersion'>;
  /** wsl.exe (an argv prefix). */
  wsl: readonly string[];
  githubApi: string;
}

/** Where the Linux uv is kept on this PC. */
export function wslUvDir(enginesDir: string): string {
  return path.join(enginesDir, 'wsl');
}

/** The Linux uv for `distro` (a Windows path), installed first when missing. */
export function wslUv(o: WslUvOptions): (distro: string, progress: ProgressSink, signal: AbortSignal) => Promise<string> {
  return async (distro, progress, signal) => {
    const { proc } = o.deps;
    // Its only program is the uv on this PC's disk: an absolute path, always one the distro can reach.
    const run: ProcessRunner['run'] = (cmd, args, opts) => distroRunner(proc, o.wsl, distro)((wslPathOf(cmd, distro) as { path: string }).path, args, opts);
    const installer = new UvInstaller({
      fetch: o.deps.fetch,
      proc: { run, spawn: proc.spawn.bind(proc) },
      clock: o.deps.clock,
      platform: 'linux',
      arch: o.deps.arch,
      enginesDir: wslUvDir(o.deps.paths.enginesDir),
      githubApi: o.githubApi,
      appVersion: o.deps.appVersion,
      // Its files are on this PC's disk (Windows has no execute bit to set: the distro runs them as they are).
      chmod: () => Promise.resolve(),
    });
    const have = await installer.uvPath();
    if (have) return have;
    // Its own 'done' is not the install's: the environment comes next.
    const done = await installer.install((p) => progress({ ...p, stage: p.stage === 'done' ? 'venv' : p.stage }), signal);
    return done.path;
  };
}
