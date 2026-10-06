import { z } from 'zod';
import { AppError } from '../../contract/errors';
import type { ProcessRunner } from '../deps';
import { system32 } from './wsl';

/** Windows PowerShell 5.1 ships with every Windows 10/11: no PowerShell 7 needed. */
export function powershellPath(env: Record<string, string | undefined>): string {
  return system32(env, 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

const PS_ARGS = ['-NoProfile', '-NonInteractive', '-Command'];

/**
 * Fixed scripts: the file path arrives through an environment variable, never inside the
 * command text, so no path can inject PowerShell. Enum values are stringified explicitly
 * because ConvertTo-Json writes enums as numbers in Windows PowerShell 5.1.
 */
export const VERIFY_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  '$s = Get-AuthenticodeSignature -LiteralPath $env:GPUBENCH_VERIFY_FILE',
  '[pscustomobject]@{ Status = [string]$s.Status; StatusMessage = [string]$s.StatusMessage;',
  '  Subject = if ($s.SignerCertificate) { [string]$s.SignerCertificate.Subject } else { $null };',
  '  Thumbprint = if ($s.SignerCertificate) { [string]$s.SignerCertificate.Thumbprint } else { $null } } | ConvertTo-Json -Compress',
].join('\n');

/**
 * Starts the installer like a double-click (ShellExecute): its own manifest decides whether
 * Windows shows the UAC prompt, and the user goes through the installer's own pages. No
 * arguments are passed, in particular nothing that accepts a license on the user's behalf.
 * NativeErrorCode 1223 = ERROR_CANCELLED (the user said "No" to UAC).
 */
export const LAUNCH_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  'try {',
  '  $p = Start-Process -FilePath $env:GPUBENCH_INSTALLER -Wait -PassThru',
  '  [pscustomobject]@{ exitCode = $p.ExitCode } | ConvertTo-Json -Compress',
  '} catch {',
  '  $e = $_.Exception; $native = $null',
  "  while ($e) { if ($e.PSObject.Properties['NativeErrorCode']) { $native = $e.NativeErrorCode }; $e = $e.InnerException }",
  "  [pscustomobject]@{ error = 'start-failed'; nativeErrorCode = $native; message = [string]$_.Exception.Message } | ConvertTo-Json -Compress",
  '}',
].join('\n');

const signatureSchema = z.object({
  Status: z.union([z.string(), z.number()]),
  StatusMessage: z.string().nullish(),
  Subject: z.string().nullish(),
  Thumbprint: z.string().nullish(),
});

export interface AuthenticodeInfo {
  status: string;
  subject?: string;
  thumbprint?: string;
}

/** SignatureStatus enum order, for a JSON that carries the number instead of the name. */
const STATUS_NAMES = ['Valid', 'UnknownError', 'NotSigned', 'HashMismatch', 'NotTrusted', 'NotSupportedFileFormat', 'Incompatible'];

/** Parses the JSON of VERIFY_SCRIPT (last JSON line of stdout). */
export function parseAuthenticode(stdout: string): AuthenticodeInfo | undefined {
  const line = stdout
    .split(/\r?\n/)
    .reverse()
    .find((l) => l.trim().startsWith('{'));
  if (line === undefined) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return undefined;
  }
  const r = signatureSchema.safeParse(raw);
  if (!r.success) return undefined;
  const s = r.data;
  const status = typeof s.Status === 'number' ? (STATUS_NAMES[s.Status] ?? String(s.Status)) : s.Status;
  return { status, ...(s.Subject ? { subject: s.Subject } : {}), ...(s.Thumbprint ? { thumbprint: s.Thumbprint } : {}) };
}

/** Value of one RDN (CN, O…) in an X.500 subject string ("CN=Docker Inc, O=Docker Inc, L=…"). */
export function subjectField(subject: string, key: string): string | undefined {
  for (const part of subject.split(/,(?=\s*[A-Za-z0-9.]+=)/)) {
    const m = /^\s*([A-Za-z0-9.]+)=(.*)$/.exec(part);
    if (m && (m[1] as string).toUpperCase() === key.toUpperCase()) return (m[2] as string).trim().replace(/^"(.*)"$/, '$1');
  }
  return undefined;
}

/** Docker's code-signing identity: organization or common name exactly "Docker Inc" (comma/period tolerated). */
export const DOCKER_SIGNER = /^Docker,? Inc\.?$/;

function rejected(reason: string, params: Record<string, string> = {}): AppError {
  return new AppError('ENGINE_INSTALL_FAILED', `Installer signature check failed: ${reason}`, {
    params: { component: 'docker-desktop', reason: 'bad-signature', check: reason, ...params },
  });
}

/**
 * Verifies the Authenticode signature (chain trusted by Windows, file unmodified) and the
 * signer, before anything downloaded is executed. Throws AppError on any doubt.
 */
export async function verifyAuthenticode(
  proc: ProcessRunner,
  env: Record<string, string | undefined>,
  file: string,
  signer: RegExp = DOCKER_SIGNER,
  timeoutMs = 60_000,
): Promise<AuthenticodeInfo> {
  const out = await proc.run(powershellPath(env), [...PS_ARGS, VERIFY_SCRIPT], { timeoutMs, env: { GPUBENCH_VERIFY_FILE: file } });
  const info = out.code === 0 ? parseAuthenticode(out.stdout) : undefined;
  if (!info) throw rejected('no-result', { detail: (out.stderr || out.stdout).slice(-500) });
  if (info.status !== 'Valid') throw rejected('status', { status: info.status });
  const subject = info.subject ?? '';
  const org = subjectField(subject, 'O');
  const cn = subjectField(subject, 'CN');
  if (!(org !== undefined && signer.test(org)) && !(cn !== undefined && signer.test(cn))) {
    throw rejected('signer', { subject });
  }
  return info;
}

export interface LaunchResult {
  exitCode?: number;
  /** ShellExecute failed; 1223 = UAC declined. */
  nativeErrorCode?: number;
  message?: string;
}

const launchSchema = z.object({
  exitCode: z.number().nullish(),
  error: z.string().optional(),
  nativeErrorCode: z.number().nullish(),
  message: z.string().nullish(),
});

/** Parses the JSON of LAUNCH_SCRIPT; undefined when PowerShell printed nothing usable. */
export function parseLaunch(stdout: string): LaunchResult | undefined {
  const line = stdout
    .split(/\r?\n/)
    .reverse()
    .find((l) => l.trim().startsWith('{'));
  if (line === undefined) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return undefined;
  }
  const r = launchSchema.safeParse(raw);
  if (!r.success) return undefined;
  const d = r.data;
  return {
    ...(typeof d.exitCode === 'number' ? { exitCode: d.exitCode } : {}),
    ...(typeof d.nativeErrorCode === 'number' ? { nativeErrorCode: d.nativeErrorCode } : {}),
    ...(d.message ? { message: d.message } : {}),
  };
}

/** Runs an installer interactively and waits for it (no timeout: the user may take their time). */
export async function launchInteractive(
  proc: ProcessRunner,
  env: Record<string, string | undefined>,
  file: string,
  signal?: AbortSignal,
): Promise<LaunchResult> {
  const out = await proc.run(powershellPath(env), [...PS_ARGS, LAUNCH_SCRIPT], {
    env: { GPUBENCH_INSTALLER: file },
    ...(signal ? { signal } : {}),
  });
  // Aborting kills PowerShell (not the installer window the user already sees).
  if (signal?.aborted) throw new AppError('CANCELLED', 'Installer launch cancelled');
  const res = parseLaunch(out.stdout);
  if (!res) {
    throw new AppError('ENGINE_INSTALL_FAILED', 'Could not start the installer', {
      params: { component: 'docker-desktop', reason: 'launch-failed' },
      detail: (out.stderr || out.stdout).slice(-500),
    });
  }
  return res;
}
