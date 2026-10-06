import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Platform } from '../deps';

/** Where an endpoint candidate came from (diagnostics, and to explain the choice in the UI). */
export type EndpointSource = 'override' | 'env' | 'context' | 'default';

/**
 * A Docker Engine API endpoint. Named pipes and unix sockets both go through node:http's
 * `socketPath`; tcp endpoints are plain HTTP (TLS endpoints are recognised but not supported by
 * our minimal client: the docker CLI keeps working for them).
 */
export type DockerEndpoint =
  | { kind: 'socket'; path: string; source: EndpointSource }
  | { kind: 'tcp'; host: string; port: number; tls: boolean; source: EndpointSource };

export interface EndpointDeps {
  platform: Platform;
  env: Record<string, string | undefined>;
  home: string;
  /** CoreEndpoints.dockerHost: wins over everything. */
  override?: string;
  readFile?: (p: string) => Promise<string>;
  /** POSIX uid for the rootless socket (defaults to process.getuid()). */
  uid?: number;
}

/** `npipe:////./pipe/name` → `\\.\pipe\name` (Windows APIs want backslashes). */
function pipePath(rest: string): string {
  return rest.replace(/\//g, '\\');
}

/**
 * Parses a DOCKER_HOST-style value: npipe://, unix://, tcp://, http(s)://, or a bare pipe/socket
 * path (accepted for the override only). ssh:// and unknown schemes return undefined.
 */
export function parseDockerHost(value: string, source: EndpointSource, tlsVerify = false): DockerEndpoint | undefined {
  const v = value.trim();
  if (v.startsWith('npipe://')) return { kind: 'socket', path: pipePath(v.slice('npipe://'.length)), source };
  if (v.startsWith('unix://')) return { kind: 'socket', path: v.slice('unix://'.length), source };
  const tcp = /^(tcp|http|https):\/\/\[?([^\]/]+?)\]?(?::(\d+))?\/?$/.exec(v);
  if (tcp) {
    const scheme = tcp[1] as string;
    const tls = scheme === 'https' || (scheme === 'tcp' && tlsVerify);
    const port = tcp[3] !== undefined ? Number(tcp[3]) : tls ? 2376 : 2375;
    return { kind: 'tcp', host: tcp[2] as string, port, tls, source };
  }
  if (source === 'override' && (/^[\\/]{2}[.?][\\/]pipe[\\/]/.test(v) || v.startsWith('/'))) {
    return { kind: 'socket', path: v.startsWith('/') && !v.startsWith('//') ? v : pipePath(v), source };
  }
  return undefined;
}

/** `~/.docker` or $DOCKER_CONFIG. */
export function dockerConfigDir(env: Record<string, string | undefined>, home: string): string {
  return env.DOCKER_CONFIG || path.join(home, '.docker');
}

/** The CLI stores each context under contexts/meta/<sha256(name)>/meta.json. */
export function contextMetaFile(configDir: string, name: string): string {
  return path.join(configDir, 'contexts', 'meta', createHash('sha256').update(name).digest('hex'), 'meta.json');
}

/** Name of the active context: $DOCKER_CONTEXT, else config.json currentContext, else undefined ("default"). */
export async function currentContext(
  env: Record<string, string | undefined>,
  configDir: string,
  readFile: (p: string) => Promise<string>,
): Promise<string | undefined> {
  if (env.DOCKER_CONTEXT) return env.DOCKER_CONTEXT;
  try {
    const cfg = JSON.parse(await readFile(path.join(configDir, 'config.json'))) as { currentContext?: unknown };
    return typeof cfg.currentContext === 'string' && cfg.currentContext ? cfg.currentContext : undefined;
  } catch {
    return undefined;
  }
}

/** Docker host of a named context, read straight from the CLI's context store (no CLI call). */
export async function contextHost(configDir: string, name: string, readFile: (p: string) => Promise<string>): Promise<string | undefined> {
  try {
    const meta = JSON.parse(await readFile(contextMetaFile(configDir, name))) as {
      Endpoints?: { docker?: { Host?: unknown } };
    };
    const host = meta.Endpoints?.docker?.Host;
    return typeof host === 'string' && host ? host : undefined;
  } catch {
    return undefined;
  }
}

export function defaultEndpoints(platform: Platform, env: Record<string, string | undefined>, home: string, uid?: number): DockerEndpoint[] {
  const sock = (p: string): DockerEndpoint => ({ kind: 'socket', path: p, source: 'default' });
  if (platform === 'win32') {
    // Docker Desktop (Linux containers) first, then the engine pipe (Windows containers / Docker CE).
    return [sock('\\\\.\\pipe\\dockerDesktopLinuxEngine'), sock('\\\\.\\pipe\\docker_engine')];
  }
  const out = [sock('/var/run/docker.sock')];
  if (env.XDG_RUNTIME_DIR) out.push(sock(path.posix.join(env.XDG_RUNTIME_DIR, 'docker.sock')));
  // Docker Desktop for Linux / macOS.
  out.push(sock(path.posix.join(home.replace(/\\/g, '/'), '.docker', 'desktop', 'docker.sock')));
  if (platform === 'darwin') out.push(sock(path.posix.join(home.replace(/\\/g, '/'), '.docker', 'run', 'docker.sock')));
  // Rootless Docker without XDG_RUNTIME_DIR in our environment (e.g. started from a desktop launcher).
  if (uid !== undefined) out.push(sock(`/run/user/${uid}/docker.sock`));
  return out;
}

export function endpointKey(e: DockerEndpoint): string {
  return e.kind === 'socket' ? `socket:${e.path}` : `tcp:${e.host}:${e.port}:${e.tls}`;
}

/**
 * Candidate endpoints in the order the docker CLI would pick them: override → DOCKER_HOST →
 * current context → well-known pipes/sockets. The client tries them in order.
 */
export async function resolveDockerEndpoints(d: EndpointDeps): Promise<DockerEndpoint[]> {
  const readFile = d.readFile ?? ((p: string) => fs.readFile(p, 'utf8'));
  const out: DockerEndpoint[] = [];
  const add = (e: DockerEndpoint | undefined) => {
    if (e && !out.some((o) => endpointKey(o) === endpointKey(e))) out.push(e);
  };
  if (d.override) add(parseDockerHost(d.override, 'override'));
  const tlsVerify = !!d.env.DOCKER_TLS_VERIFY && d.env.DOCKER_TLS_VERIFY !== '0';
  if (d.env.DOCKER_HOST) add(parseDockerHost(d.env.DOCKER_HOST, 'env', tlsVerify));
  const configDir = dockerConfigDir(d.env, d.home);
  const ctx = await currentContext(d.env, configDir, readFile);
  if (ctx !== undefined && ctx !== 'default') {
    const host = await contextHost(configDir, ctx, readFile);
    if (host !== undefined) add(parseDockerHost(host, 'context'));
  }
  const uid = d.uid ?? (typeof process.getuid === 'function' ? process.getuid() : undefined);
  for (const e of defaultEndpoints(d.platform, d.env, d.home, uid)) add(e);
  return out;
}
