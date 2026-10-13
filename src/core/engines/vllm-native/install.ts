import path from 'node:path';
import { AppError } from '../../../contract/errors';
import type { ProcessRunner } from '../../deps';
import type { ProgressSink } from '../types';

export const VENV_DIR = 'vllm-venv';
export const DEFAULT_PYTHON = '3.12';

export interface UvInstallOptions {
  proc: ProcessRunner;
  enginesDir: string;
  /** argv prefix of uv: the bundled binary, or ["uv"] from PATH. */
  uv: string[];
  python?: string;
  /** Requirement passed to `uv pip install` (default "vllm": the newest release). */
  spec?: string;
}

export function venvPaths(enginesDir: string): { venv: string; python: string; vllm: string } {
  const venv = path.join(enginesDir, VENV_DIR);
  return { venv, python: path.join(venv, 'bin', 'python'), vllm: path.join(venv, 'bin', 'vllm') };
}

const UNITS: Record<string, number> = { B: 1, KiB: 1024, MiB: 1024 ** 2, GiB: 1024 ** 3 };

/** Progress state built from uv's non-TTY output lines. */
export class UvProgress {
  stage = 'resolve';
  bytesDone = 0;
  bytesTotal = 0;
  private readonly pending = new Map<string, number>();

  /** Returns true when the line changed the progress. */
  push(line: string): boolean {
    const t = line.trim();
    const dl = /^Downloading (\S+) \(([\d.]+)\s?(B|KiB|MiB|GiB)\)/.exec(t);
    if (dl) {
      const bytes = Math.round(Number(dl[2]) * (UNITS[dl[3] as string] as number));
      this.pending.set(dl[1] as string, bytes);
      this.bytesTotal += bytes;
      this.stage = 'download';
      return true;
    }
    const done = /^Downloaded (\S+)/.exec(t);
    if (done) {
      this.bytesDone += this.pending.get(done[1] as string) ?? 0;
      this.pending.delete(done[1] as string);
      return true;
    }
    if (/^Resolved \d+ packages?/.test(t)) {
      this.stage = 'download';
      return true;
    }
    if (/^Prepared \d+ packages?/.test(t)) {
      this.stage = 'install';
      return true;
    }
    if (/^Installed \d+ packages?/.test(t)) {
      this.stage = 'verify';
      return true;
    }
    return false;
  }
}

export function failure(stage: string, code: number | null, tail: string[], label = 'vLLM'): AppError {
  const detail = tail.join('\n');
  const params = { stage, code: String(code) };
  if (/No space left on device/i.test(detail)) return new AppError('DISK_FULL', `No space left to install ${label}`, { params, detail });
  if (/Failed to fetch|error sending request|dns error|Connection reset|timed out|Could not connect/i.test(detail)) {
    return new AppError('NETWORK', `Network error while installing ${label}`, { params, detail });
  }
  if (/\bspawn\b.*\bENOENT\b/.test(detail)) {
    return new AppError('ENGINE_INSTALL_FAILED', 'uv was not found', { params: { ...params, reason: 'uv-missing' }, detail });
  }
  return new AppError('ENGINE_INSTALL_FAILED', `${label} install failed at ${stage}`, { params, detail });
}

/** A Python environment installed with uv: its folder, its Python, what goes in it. */
export interface UvEnvSpec {
  venv: string;
  python: string;
  spec: string;
  /** "vLLM", "SGLang": for messages. */
  label: string;
  /** Marker of the uv processes (never an engine's). */
  owner: string;
}

/** `uv venv` + `uv pip install <spec> --torch-backend auto` into env.venv, with progress. */
export async function installUvEnv(o: Pick<UvInstallOptions, 'proc' | 'uv' | 'python'>, env: UvEnvSpec, progress: ProgressSink, signal: AbortSignal): Promise<UvProgress> {
  const state = new UvProgress();
  const [uvCmd, ...uvPre] = o.uv as [string, ...string[]];

  const step = async (stage: string, args: string[]) => {
    if (signal.aborted) throw new AppError('CANCELLED', `${env.label} install cancelled`);
    const mp = o.proc.spawn({ cmd: uvCmd, args: [...uvPre, ...args], owner: { runId: env.owner, marker: env.owner } });
    const onAbort = () => void mp.stop();
    signal.addEventListener('abort', onAbort, { once: true });
    const tail: string[] = [];
    try {
      for await (const l of mp.lines) {
        tail.push(l.text);
        if (tail.length > 40) tail.shift();
        if (state.push(l.text)) progress({ stage: state.stage, bytesDone: state.bytesDone, ...(state.bytesTotal > 0 ? { bytesTotal: state.bytesTotal } : {}) });
      }
      const exit = await mp.exited;
      if (signal.aborted) throw new AppError('CANCELLED', `${env.label} install cancelled`);
      if (exit.code !== 0) throw failure(stage, exit.code, tail, env.label);
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
  };

  progress({ stage: 'venv', bytesDone: 0 });
  await step('venv', ['venv', env.venv, '--python', o.python ?? DEFAULT_PYTHON, '--allow-existing']);
  progress({ stage: 'resolve', bytesDone: 0 });
  await step('install', ['pip', 'install', '--python', env.python, env.spec, '--torch-backend', 'auto']);
  progress({ stage: 'verify', bytesDone: state.bytesDone, ...(state.bytesTotal > 0 ? { bytesTotal: state.bytesTotal } : {}) });
  return state;
}

/**
 * Installs vLLM into enginesDir/vllm-venv with uv: no system Python needed (uv fetches a managed
 * CPython) and `--torch-backend auto` picks the PyTorch CUDA build matching the driver.
 */
export async function installVllm(o: UvInstallOptions, progress: ProgressSink, signal: AbortSignal): Promise<{ venv: string; vllm: string; version?: string }> {
  const p = venvPaths(o.enginesDir);
  const state = await installUvEnv(o, { venv: p.venv, python: p.python, spec: o.spec ?? 'vllm', label: 'vLLM', owner: 'vllm-install' }, progress, signal);
  const v = await o.proc.run(p.vllm, ['--version'], { timeoutMs: 300_000, signal });
  if (v.code !== 0) throw failure('verify', v.code, `${v.stdout}\n${v.stderr}`.trim().split(/\r?\n/).slice(-40));
  const version = parseVllmVersion(v.stdout);
  progress({ stage: 'done', bytesDone: state.bytesDone, ...(state.bytesTotal > 0 ? { bytesTotal: state.bytesTotal } : {}) });
  return { venv: p.venv, vllm: p.vllm, ...(version !== undefined ? { version } : {}) };
}

/** `vllm --version` prints the bare version ("0.31.0") after possible INFO log lines. */
export function parseVllmVersion(stdout: string): string | undefined {
  const lines = stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = /^v?(\d+\.\d+\.\d+(?:\.\d+)?(?:[.+-][\w.+-]+)?)$/.exec(lines[i] as string);
    if (m) return m[1];
  }
  return undefined;
}
