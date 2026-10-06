import { promises as fs } from 'node:fs';
import path from 'node:path';
import { AppError, type ErrorCode } from '../../contract/errors';
import type { ManagedProcess, Platform, ProcessRunner, RunOptions, RunOutput, SpawnSpec } from '../deps';
import { containerInfoFrom, type ContainerInfo, type ImageInfo } from './client';

/** Label every container we start carries; cleanup never touches containers without it. */
export const GPUBENCH_LABEL = 'gpubench';
export const MARKER_LABEL = 'gpubench.marker';

/** What `docker version --format json` told us. `server` is undefined when the daemon is unreachable. */
export interface CliVersion {
  code: number | null;
  client?: { version: string; context?: string; os?: string };
  server?: { version: string; os?: string; platform?: string; podman: boolean };
  stdout: string;
  stderr: string;
}

export interface PsEntry {
  id: string;
  name: string;
  image: string;
  state: string;
  labels: Record<string, string>;
}

export interface DockerCliOptions {
  proc: ProcessRunner;
  platform: Platform;
  env: Record<string, string | undefined>;
  /** CoreEndpoints.docker: argv prefix replacing the docker binary (tests: node fake-docker.mjs). */
  override?: string[];
  exists?: (p: string) => Promise<boolean>;
  /** Default timeout of short commands (version, inspect, stop…). */
  timeoutMs?: number;
}

const defaultExists = (p: string) => fs.access(p).then(
  () => true,
  () => false,
);

/** Case-insensitive env lookup (Windows copies of the environment may spell it "Path"). */
export function envValue(env: Record<string, string | undefined>, name: string, platform: Platform): string | undefined {
  if (platform !== 'win32') return env[name];
  const key = Object.keys(env).find((k) => k.toUpperCase() === name.toUpperCase());
  return key === undefined ? undefined : env[key];
}

/** Places a docker CLI may live in when it is not on PATH (e.g. an app started before Docker Desktop was installed). */
export function knownDockerPaths(platform: Platform, env: Record<string, string | undefined>): string[] {
  if (platform === 'win32') {
    const out: string[] = [];
    const pf = envValue(env, 'ProgramFiles', platform);
    const local = envValue(env, 'LOCALAPPDATA', platform);
    if (pf) out.push(path.win32.join(pf, 'Docker', 'Docker', 'resources', 'bin', 'docker.exe'));
    if (local) out.push(path.win32.join(local, 'Programs', 'DockerDesktop', 'resources', 'bin', 'docker.exe'));
    return out;
  }
  return ['/usr/bin/docker', '/usr/local/bin/docker', '/opt/homebrew/bin/docker'];
}

/** RFC3339Nano prefix written by `docker logs --timestamps`. */
const TS = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2}) ?/;

/** Splits "2026-10-06T05:12:34.123456789Z text" into epoch ms (sub-ms precision kept) and text. */
export function parseTimestampedLine(line: string): { tsMs?: number; text: string } {
  const m = TS.exec(line);
  if (!m) return { text: line };
  const base = Date.parse(`${m[1] as string}${m[3] as string}`);
  if (Number.isNaN(base)) return { text: line };
  const frac = m[2] === undefined ? 0 : Number(`0.${m[2]}`) * 1000;
  return { tsMs: base + frac, text: line.slice(m[0].length) };
}

/** Parses "k=v,k2=v2" (docker ps Labels column). */
export function parseLabels(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of s.split(',')) {
    const eq = part.indexOf('=');
    if (eq > 0) out[part.slice(0, eq)] = part.slice(eq + 1);
  }
  return out;
}

export function isOurs(labels: Record<string, string>, marker?: string): boolean {
  if (labels[GPUBENCH_LABEL] !== '1') return false;
  return marker === undefined ? true : labels[MARKER_LABEL] === marker;
}

/** The WSL "docker" shim printed when Docker Desktop's WSL integration is off. */
export const WSL_SHIM = /could not be found in this WSL \d distro/i;
const PODMAN_SHIM = /Emulate Docker CLI using podman/i;

const DAEMON_DOWN = [
  /failed to connect to the docker API/i,
  /Cannot connect to the Docker daemon/i,
  /error during connect/i,
  /Is the docker daemon running\?/i,
  /The system cannot find the file specified/i,
  /dockerDesktopLinuxEngine.*(?:no such file|not found)/i,
];
const STARTING = [
  /request returned (?:50[023] )?(?:Internal Server Error|Bad Gateway|Service Unavailable)/i,
  /Docker Desktop is (?:still )?starting/i,
  /engine.*is starting/i,
];
const PERMISSION = [/permission denied while trying to connect/i, /Got permission denied/i, /Access is denied/i, /connect: permission denied/i];
const NO_GPU = [
  /could not select device driver "[^"]*" with capabilities: \[\[gpu\]\]/i,
  /nvidia-container-cli: (?!requirement error)/i,
  /unknown or invalid runtime name: nvidia/i,
  /error running (?:prestart )?hook/i,
  /libnvidia-ml\.so/i,
  /no CDI devices? (?:found|for)/i,
  /unresolvable CDI devices/i,
];

export type DaemonState = 'stopped' | 'starting' | 'no-permission';

/** Daemon-level state from a CLI error, or undefined when the message is about something else. */
export function daemonStateFrom(stderr: string): DaemonState | undefined {
  if (PERMISSION.some((re) => re.test(stderr))) return 'no-permission';
  if (STARTING.some((re) => re.test(stderr))) return 'starting';
  if (DAEMON_DOWN.some((re) => re.test(stderr))) return 'stopped';
  return undefined;
}

/**
 * Turns a failed docker CLI call into the most specific error the message supports.
 * `fallback` is the code used when nothing matches (ENGINE_START_FAILED for `docker run`…).
 */
export function classifyDockerError(out: Pick<RunOutput, 'code' | 'stdout' | 'stderr'>, fallback: ErrorCode = 'INTERNAL'): AppError {
  const text = `${out.stderr}\n${out.stdout}`.trim();
  const detail = text.slice(-2000);
  const params: Record<string, string | number> = { code: String(out.code) };
  const err = (code: ErrorCode, msg: string, extra: Record<string, string | number> = {}) =>
    new AppError(code, msg, { params: { ...params, ...extra }, detail });

  if (/\bspawn\b.*\bENOENT\b/.test(text)) {
    return err('DOCKER_NOT_INSTALLED', 'The docker command was not found');
  }
  if (WSL_SHIM.test(text)) return err('DOCKER_NOT_INSTALLED', 'Docker Desktop WSL integration is off', { reason: 'wsl-integration' });
  const daemon = daemonStateFrom(text);
  if (daemon === 'no-permission') return err('DOCKER_PERMISSION', 'No permission to use the Docker daemon');
  if (daemon !== undefined) return err('DOCKER_NOT_RUNNING', 'Docker is not running', { reason: daemon });
  const cuda = /unsatisfied condition: cuda\s*>=\s*([\d.]+)/i.exec(text);
  if (cuda) return err('DRIVER_TOO_OLD', 'The NVIDIA driver is too old for this image', { cuda: cuda[1] as string });
  if (NO_GPU.some((re) => re.test(text))) return err('DOCKER_NO_GPU', 'Docker cannot access the NVIDIA GPU');
  if (/port is already allocated|address already in use|Ports are not available|bind: (?:An attempt was made|only one usage)/i.test(text)) {
    return err('ENGINE_PORT_IN_USE', 'The port is already in use');
  }
  if (/No such image/i.test(text)) return err('ENGINE_NOT_INSTALLED', 'The Docker image is not present', { reason: 'image-missing' });
  if (/pull access denied|manifest unknown|manifest for .* not found|repository does not exist|toomanyrequests/i.test(text)) {
    return err('DOCKER_PULL_FAILED', 'The Docker image could not be pulled');
  }
  if (/no space left on device/i.test(text)) return err('DISK_FULL', 'No space left on the Docker disk');
  if (/bind source path does not exist|invalid mount config|Mounts denied|not shared from the host/i.test(text)) {
    return err('MODEL_NOT_FOUND', 'The model folder cannot be mounted in the container', { reason: 'mount' });
  }
  if (/is already in use by container/i.test(text)) return err('ENGINE_START_FAILED', 'Container name conflict', { reason: 'name-conflict' });
  // "unknown flag: --bogus" / "unknown shorthand flag: 'z' in -z"
  const flag = /unknown flag:? (-{1,2}[\w-]+)/i.exec(text)?.[1] ?? /unknown shorthand flag: '\w' in (-[\w-]+)/i.exec(text)?.[1];
  if (flag !== undefined) return err('ENGINE_BAD_FLAG', `Rejected argument: ${flag}`, { flag });
  if (/invalid reference format/i.test(text)) return err('VALIDATION', 'Invalid image reference');
  return err(fallback, `docker failed with exit code ${String(out.code)}`);
}

/**
 * Thin wrapper over the docker CLI. Containers are created with the CLI (never the API) so the
 * command stored with each benchmark is exactly the one that ran; everything goes through
 * ProcessRunner with argument arrays.
 */
export class DockerCli {
  private resolved: Promise<string[]> | undefined;
  private readonly exists: (p: string) => Promise<boolean>;
  readonly timeoutMs: number;

  constructor(private readonly o: DockerCliOptions) {
    this.exists = o.exists ?? defaultExists;
    this.timeoutMs = o.timeoutMs ?? 30_000;
  }

  /**
   * argv prefix of the docker CLI: the override, else plain "docker" when it is on PATH (keeps the
   * stored command short and copyable), else a well-known install location, else "docker".
   */
  command(): Promise<string[]> {
    this.resolved ??= this.resolve();
    return this.resolved;
  }

  private async resolve(): Promise<string[]> {
    if (this.o.override && this.o.override.length > 0) return [...this.o.override];
    const win = this.o.platform === 'win32';
    const exe = win ? 'docker.exe' : 'docker';
    const dirs = (envValue(this.o.env, 'PATH', this.o.platform) ?? '').split(win ? ';' : ':').filter(Boolean);
    for (const d of dirs) if (await this.exists((win ? path.win32 : path.posix).join(d, exe))) return ['docker'];
    for (const p of knownDockerPaths(this.o.platform, this.o.env)) if (await this.exists(p)) return [p];
    return ['docker'];
  }

  /** Runs `docker <args>`. */
  async exec(args: readonly string[], opts: RunOptions = {}): Promise<RunOutput> {
    const [cmd, ...pre] = (await this.command()) as [string, ...string[]];
    return this.o.proc.run(cmd, [...pre, ...args], { timeoutMs: this.timeoutMs, ...opts });
  }

  /** Spawns a long-running `docker <args>` (logs -f, pull…). */
  async spawn(args: readonly string[], owner: SpawnSpec['owner'], env?: Record<string, string>): Promise<ManagedProcess> {
    const [cmd, ...pre] = (await this.command()) as [string, ...string[]];
    return this.o.proc.spawn({ cmd, args: [...pre, ...args], owner, ...(env ? { env } : {}) });
  }

  async version(): Promise<CliVersion> {
    const out = await this.exec(['version', '--format', 'json'], { timeoutMs: 20_000 });
    return parseCliVersion(out);
  }

  /** Container JSON (`docker container inspect`), undefined when it does not exist. */
  async inspect(id: string): Promise<ContainerInfo | undefined> {
    const out = await this.exec(['container', 'inspect', id]);
    const first = firstJson(out.stdout);
    if (out.code !== 0 || !first) return undefined;
    return containerInfoFrom(first);
  }

  async imageInspect(ref: string): Promise<ImageInfo | undefined> {
    const out = await this.exec(['image', 'inspect', ref]);
    if (out.code !== 0) {
      if (/No such image/i.test(out.stderr)) return undefined;
      throw classifyDockerError(out);
    }
    const first = firstJson(out.stdout);
    if (!first) return undefined;
    const strs = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
    return {
      id: typeof first.Id === 'string' ? first.Id : '',
      repoTags: strs(first.RepoTags),
      repoDigests: strs(first.RepoDigests),
      size: typeof first.Size === 'number' ? first.Size : 0,
    };
  }

  /** `docker ps -a` filtered by labels (`{{json .}}` works on every CLI version, unlike `--format json`). */
  async ps(labelFilters: readonly string[]): Promise<PsEntry[]> {
    const args = ['ps', '-a', '--no-trunc'];
    for (const f of labelFilters) args.push('--filter', `label=${f}`);
    args.push('--format', '{{json .}}');
    const out = await this.exec(args);
    if (out.code !== 0) throw classifyDockerError(out);
    const rows: PsEntry[] = [];
    for (const line of out.stdout.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line) as Record<string, unknown>;
        rows.push({
          id: String(r.ID ?? ''),
          name: String(r.Names ?? ''),
          image: String(r.Image ?? ''),
          state: String(r.State ?? ''),
          labels: parseLabels(String(r.Labels ?? '')),
        });
      } catch {
        /* a warning line, not JSON */
      }
    }
    return rows;
  }

  /** `docker stop -t N id`; a container that is already gone is not an error. */
  async stop(id: string, timeoutSec: number): Promise<void> {
    const out = await this.exec(['stop', '-t', String(timeoutSec), id], { timeoutMs: (timeoutSec + 30) * 1000 });
    if (out.code !== 0 && !/No such container/i.test(out.stderr)) throw classifyDockerError(out);
  }

  async rm(id: string, force = true): Promise<void> {
    const out = await this.exec(force ? ['rm', '-f', id] : ['rm', id]);
    if (out.code !== 0 && !/No such container/i.test(out.stderr)) throw classifyDockerError(out);
  }

  /** `docker logs -f --timestamps id` as a managed process (ends when the container stops). */
  followLogs(id: string, owner: SpawnSpec['owner']): Promise<ManagedProcess> {
    return this.spawn(['logs', '-f', '--timestamps', id], owner);
  }
}

function firstJson(stdout: string): Record<string, unknown> | undefined {
  try {
    const v = JSON.parse(stdout) as unknown;
    const first = Array.isArray(v) ? (v[0] as unknown) : undefined;
    return first && typeof first === 'object' ? (first as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** Parses `docker version --format json` (Server is null when the daemon is unreachable). */
export function parseCliVersion(out: RunOutput): CliVersion {
  const res: CliVersion = { code: out.code, stdout: out.stdout, stderr: out.stderr };
  let j: { Client?: Record<string, unknown> | null; Server?: Record<string, unknown> | null } | undefined;
  try {
    j = JSON.parse(out.stdout.trim().split(/\r?\n/)[0] as string) as typeof j;
  } catch {
    return res;
  }
  const s = (v: unknown) => (typeof v === 'string' && v !== '' ? v : undefined);
  const c = j?.Client;
  if (c) {
    res.client = { version: s(c.Version) ?? '' };
    const ctx = s(c.Context);
    const os = s(c.Os);
    if (ctx !== undefined) res.client.context = ctx;
    if (os !== undefined) res.client.os = os;
  }
  const sv = j?.Server;
  if (sv) {
    const components = Array.isArray(sv.Components) ? sv.Components.map((x: unknown) => s((x as { Name?: unknown } | null)?.Name) ?? '') : [];
    const platform = s((sv.Platform as { Name?: unknown } | undefined)?.Name);
    res.server = {
      version: s(sv.Version) ?? '',
      podman: components.some((n) => /podman/i.test(n)) || /podman/i.test(platform ?? '') || PODMAN_SHIM.test(out.stderr),
    };
    const os = s(sv.Os);
    if (os !== undefined) res.server.os = os;
    if (platform !== undefined) res.server.platform = platform;
  }
  return res;
}
