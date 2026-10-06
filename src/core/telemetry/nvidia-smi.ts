import { stat } from 'node:fs/promises';
import path from 'node:path';
import { AppError } from '../../contract/errors';
import type { Platform, ProcessRunner, RunOutput } from '../deps';
import {
  activeFields,
  initialChoice,
  minimalChoice,
  unsupportedField,
  withoutField,
  type ActiveField,
  type FieldChoice,
  type FieldSpec,
} from './fields';

/** Where nvidia-smi lives. `argv` is a prefix: tests use ['node', 'fake-nvidia-smi.mjs']. */
export interface NvidiaSmiLocation {
  argv: [string, ...string[]];
  /** Shown in the UI (Sistema → nvidia-smi). */
  path: string;
  source: 'override' | 'path' | 'known';
}

export type FileExists = (p: string) => Promise<boolean>;

export interface LocateOptions {
  platform: Platform;
  env: Record<string, string | undefined>;
  /** CoreEndpoints.nvidiaSmi: argv prefix that bypasses the lookup. */
  override?: string[] | undefined;
  fileExists?: FileExists;
}

export const defaultFileExists: FileExists = async (p) => {
  try {
    return (await stat(p)).isFile();
  } catch {
    return false;
  }
};

/** Windows env vars are case-insensitive ("Path" vs "PATH") but a copied env object is not. */
export function envGet(env: Record<string, string | undefined>, name: string, platform: Platform): string | undefined {
  if (platform !== 'win32') return env[name];
  const key = Object.keys(env).find((k) => k.toLowerCase() === name.toLowerCase());
  return key === undefined ? undefined : env[key];
}

/** Candidate paths in lookup order: PATH entries, then the driver's well-known install locations. */
export function nvidiaSmiCandidates(platform: Platform, env: Record<string, string | undefined>): { path: string; source: 'path' | 'known' }[] {
  const isWin = platform === 'win32';
  const p = isWin ? path.win32 : path.posix;
  const exe = isWin ? 'nvidia-smi.exe' : 'nvidia-smi';
  const dirs = (envGet(env, 'PATH', platform) ?? '')
    .split(isWin ? ';' : ':')
    .map((d) => d.trim().replace(/^"(.*)"$/, '$1'))
    .filter((d) => d.length > 0);
  const out: { path: string; source: 'path' | 'known' }[] = dirs.map((d) => ({ path: p.join(d, exe), source: 'path' as const }));
  if (isWin) {
    const systemRoot = envGet(env, 'SystemRoot', platform) ?? 'C:\\Windows';
    const programFiles = envGet(env, 'ProgramFiles', platform) ?? 'C:\\Program Files';
    out.push({ path: p.join(systemRoot, 'System32', exe), source: 'known' });
    out.push({ path: p.join(programFiles, 'NVIDIA Corporation', 'NVSMI', exe), source: 'known' });
  } else if (platform === 'linux') {
    out.push({ path: '/usr/bin/nvidia-smi', source: 'known' });
    // WSL exposes the Windows driver's tools here (often, but not always, on PATH).
    out.push({ path: '/usr/lib/wsl/lib/nvidia-smi', source: 'known' });
  }
  return out;
}

/** Finds nvidia-smi: endpoint override, else PATH, else known install locations. undefined = not installed. */
export async function locateNvidiaSmi(opts: LocateOptions): Promise<NvidiaSmiLocation | undefined> {
  const [cmd, ...rest] = opts.override ?? [];
  if (cmd !== undefined) return { argv: [cmd, ...rest], path: [cmd, ...rest].join(' '), source: 'override' };
  const exists = opts.fileExists ?? defaultFileExists;
  for (const c of nvidiaSmiCandidates(opts.platform, opts.env)) {
    if (await exists(c.path)) return { argv: [c.path], path: c.path, source: c.source };
  }
  return undefined;
}

export interface DriverInfo {
  driverVersion?: string;
  cudaVersion?: string;
}

/**
 * Driver + CUDA version from `nvidia-smi --version` or the plain `nvidia-smi` header. Handles both
 * the classic names ("Driver Version: 535.x  CUDA Version: 12.2") and driver 617+, where those are
 * "Deprecated" and the real values are "KMD Version" and "CUDA UMD Version".
 */
export function parseDriverInfo(output: string): DriverInfo {
  const pick = (...res: RegExp[]) => {
    for (const re of res) {
      const m = re.exec(output);
      if (m?.[1]) return m[1];
    }
    return undefined;
  };
  const out: DriverInfo = {};
  const driver = pick(/KMD Version\s*:\s*(\d+(?:\.\d+)+)/i, /Driver Version\s*:\s*(\d+(?:\.\d+)+)/i);
  const cuda = pick(/CUDA UMD Version\s*:\s*(\d+\.\d+)/i, /CUDA Version\s*:\s*(\d+\.\d+)/i);
  if (driver) out.driverVersion = driver;
  if (cuda) out.cudaVersion = cuda;
  return out;
}

function tail(text: string, max = 800): string {
  const t = text.trim();
  return t.length > max ? t.slice(-max) : t;
}

/** Maps a failed nvidia-smi run to an AppError with the right code for the UI's "what to do" action. */
export function classifyFailure(out: RunOutput): AppError {
  const all = `${out.stdout}\n${out.stderr}`;
  const detail = tail(all);
  const opts = detail ? { detail } : {};
  if (out.timedOut) return new AppError('INTERNAL', 'nvidia-smi did not answer in time', opts);
  if (/No devices were found/i.test(all)) return new AppError('GPU_NOT_FOUND', 'nvidia-smi found no NVIDIA GPU', opts);
  if (out.code === null || /couldn't communicate with the NVIDIA driver|NVIDIA-SMI has failed|Failed to initialize NVML|ENOENT/i.test(all)) {
    return new AppError('DRIVER_MISSING', 'nvidia-smi cannot reach the NVIDIA driver', opts);
  }
  return new AppError('INTERNAL', `nvidia-smi failed with exit code ${String(out.code)}`, opts);
}

export interface FieldQueryResult {
  choice: FieldChoice;
  fields: ActiveField[];
  stdout: string;
}

/** Thin wrapper over the ProcessRunner that knows the nvidia-smi argv prefix and its quirks. */
export class NvidiaSmiCli {
  constructor(
    private readonly proc: ProcessRunner,
    readonly location: NvidiaSmiLocation,
    private readonly timeoutMs = 15_000,
  ) {}

  /** argv for spawn(): [cmd, args]. */
  command(args: string[]): { cmd: string; args: string[] } {
    const [cmd, ...prefix] = this.location.argv;
    return { cmd, args: [...prefix, ...args] };
  }

  run(args: string[]): Promise<RunOutput> {
    const c = this.command(args);
    return this.proc.run(c.cmd, c.args, { timeoutMs: this.timeoutMs });
  }

  /** Runs and returns stdout; throws a classified AppError on failure. */
  async text(args: string[]): Promise<string> {
    const out = await this.run(args);
    if (out.code !== 0 || out.timedOut) throw classifyFailure(out);
    return out.stdout;
  }

  /**
   * Runs `--query-gpu`/`--query-compute-apps` with the given field specs. When the driver rejects a
   * field, switches to its alias or drops it and retries; if the rejected field cannot be
   * identified, retries once with the minimal list. The resolved choice is returned for caching.
   */
  async queryFields(
    queryFlag: '--query-gpu' | '--query-compute-apps',
    specs: readonly FieldSpec[],
    start: FieldChoice = initialChoice(specs),
    extraArgs: string[] = [],
  ): Promise<FieldQueryResult> {
    let choice = start;
    let usedMinimal = false;
    // Each retry removes one alias, so the loop is bounded by the number of names (+1 minimal pass).
    for (;;) {
      const fields = activeFields(specs, choice);
      const out = await this.run([`${queryFlag}=${fields.map((f) => f.name).join(',')}`, '--format=csv,noheader,nounits', ...extraArgs]);
      const rejected = unsupportedField(out.stdout + out.stderr);
      if (rejected === undefined) {
        if (out.code !== 0 || out.timedOut) throw classifyFailure(out);
        return { choice, fields, stdout: out.stdout };
      }
      const next = rejected ? withoutField(specs, choice, rejected) : undefined;
      if (next) {
        choice = next;
        continue;
      }
      if (usedMinimal) {
        throw new AppError('DRIVER_TOO_OLD', 'nvidia-smi does not support the fields GPU Bench needs', {
          params: { field: rejected },
          detail: tail(out.stdout + out.stderr),
        });
      }
      usedMinimal = true;
      choice = minimalChoice(specs);
    }
  }
}
