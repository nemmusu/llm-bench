import path from 'node:path';
import type { ProcessRunner } from '../deps';
import { compareVersions, parseDriverVersion } from './driver';

/** Docker Desktop's documented minimum WSL version (docs.docker.com/desktop/setup/install/windows-install/). */
export const DOCKER_MIN_WSL = '2.1.5';

export interface WslStatus {
  /** `wsl --status` succeeded: the WSL platform is installed. */
  available: boolean;
  /** "Default Version: 2" (localized label, so only the value is parsed). */
  defaultVersion?: number;
  /** First version in `wsl --version` (Store WSL only; inbox WSL lacks --version). */
  version?: string;
  /** version >= DOCKER_MIN_WSL; undefined when the version is unknown. */
  meetsDockerMinimum?: boolean;
  /** Why WSL is not available: wsl.exe missing, or it answered with an error. */
  reason?: 'wsl-missing' | 'not-installed';
}

/**
 * wsl.exe writes UTF-16LE to pipes unless WSL_UTF8=1 is honoured (older builds ignore it).
 * Decoded as UTF-8 that text has a NUL after every ASCII char: dropping NULs and the BOM
 * recovers every ASCII character, which is all the parsers below need.
 */
export function decodeWslOutput(text: string): string {
  return text.split(String.fromCharCode(0)).join('').replace(/^\uFEFF/, '');
}

/** The value of the first "label: N" line with N = 1 or 2 ("Default Version: 2", "Versione predefinita: 2"). */
export function parseWslDefaultVersion(text: string): number | undefined {
  const m = /^[^:\r\n]+:\s*([12])\s*$/m.exec(decodeWslOutput(text));
  return m ? Number(m[1]) : undefined;
}

/** First dotted version on the first line of `wsl --version` ("WSL version: 2.7.14.0"). */
export function parseWslVersion(text: string): string | undefined {
  const first = decodeWslOutput(text).split(/\r?\n/).find((l) => l.trim() !== '') ?? '';
  return /(\d+\.\d+\.\d+(?:\.\d+)?)/.exec(first)?.[1];
}

/** %SystemRoot%\System32\<exe>: absolute, so a planted wsl.exe/powershell.exe on PATH is never picked. */
export function system32(env: Record<string, string | undefined>, ...parts: string[]): string {
  const root = env.SystemRoot ?? env.SYSTEMROOT ?? env.windir ?? 'C:\\Windows';
  return path.win32.join(root, 'System32', ...parts);
}

/** WSL availability for Docker Desktop's WSL 2 backend. Never throws. */
export async function detectWsl(proc: ProcessRunner, env: Record<string, string | undefined>, timeoutMs = 15_000): Promise<WslStatus> {
  const wsl = system32(env, 'wsl.exe');
  const opts = { timeoutMs, env: { WSL_UTF8: '1' } };
  const status = await proc.run(wsl, ['--status'], opts).catch(() => undefined);
  if (!status || (status.code === null && !status.timedOut)) return { available: false, reason: 'wsl-missing' };
  if (status.code !== 0) return { available: false, reason: 'not-installed' };
  const out: WslStatus = { available: true };
  const def = parseWslDefaultVersion(status.stdout);
  if (def !== undefined) out.defaultVersion = def;
  const ver = await proc.run(wsl, ['--version'], opts).catch(() => undefined);
  const version = ver?.code === 0 ? parseWslVersion(ver.stdout) : undefined;
  if (version !== undefined) {
    out.version = version;
    out.meetsDockerMinimum = compareVersions(parseDriverVersion(version) as number[], parseDriverVersion(DOCKER_MIN_WSL) as number[]) >= 0;
  }
  return out;
}
