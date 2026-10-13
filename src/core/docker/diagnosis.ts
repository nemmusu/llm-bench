/**
 * Why Docker Desktop stopped answering, read from its own log and settings (both only read, never
 * changed). The pattern seen on real PCs: its "Resource Saver" stops the engine after a few minutes
 * without running containers ("system idle for 5m0s -> reducing", "stopping VM"); now and then that
 * stop never finishes (the engine stays "stopping"), while its API cache keeps answering `docker
 * version` as if all were well. Only a restart brings it back; turning Resource Saver off avoids it.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { DockerDiagnosis, DockerHangReason } from '../../contract/docker';
import type { Platform } from '../deps';
import { envValue } from './cli';

export interface DiagnosisDeps {
  platform: Platform;
  env: Record<string, string | undefined>;
  /** A whole small file (settings-store.json). */
  readFile(p: string): Promise<string>;
  /** The last `bytes` of a log file. */
  readTail(p: string, bytes: number): Promise<string>;
  /** Wall clock (ms since epoch): a stop still "going on" a minute later is stuck. */
  now(): number;
}

/** Docker Desktop's defaults when its settings do not say (Resource Saver on, after 5 minutes). */
export const RESOURCE_SAVER_DEFAULT = { enabled: true, timeoutSeconds: 300 } as const;
/** How much of each log is read: the last state changes are always near its end. */
export const LOG_TAIL_BYTES = 512 * 1024;
/** A stop not finished after this long is stuck (a normal one takes about a second). */
export const STOP_STUCK_MS = 60_000;
/** Resource Saver's "stopping VM" comes right before the engine's own "running -> stopping". */
const IDLE_TO_STOP_MS = 10_000;
const EVIDENCE_MAX = 6;

/** Resource Saver as Docker Desktop saved it in settings-store.json (absent keys = its defaults). */
export function resourceSaverFrom(json: string): { enabled: boolean; timeoutSeconds: number } {
  let s: Record<string, unknown> = {};
  try {
    const v = JSON.parse(json) as unknown;
    if (v && typeof v === 'object') s = v as Record<string, unknown>;
  } catch {
    /* unreadable: Docker's defaults apply */
  }
  const t = s.AutoPauseTimeoutSeconds;
  return {
    enabled: typeof s.UseResourceSaver === 'boolean' ? s.UseResourceSaver : RESOURCE_SAVER_DEFAULT.enabled,
    timeoutSeconds: typeof t === 'number' && t > 0 ? t : RESOURCE_SAVER_DEFAULT.timeoutSeconds,
  };
}

export interface EngineEvent {
  /** ms since epoch. */
  at: number;
  /** 'idle': Resource Saver decided to stop the engine; the rest are the engine's new states. */
  kind: 'idle' | 'stopping' | 'stopped' | 'starting' | 'running' | 'other';
  line: string;
}

/** "[2026-10-09T19:24:55.162871900Z]…" at the start of every line of Docker Desktop's host logs. */
const STAMP = /^\[(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?Z\]/;
const IDLE = /system idle for .* -> reducing|\]\s*stopping VM\s*$/;
const STATE = /setting engine \S+ state \w+ -> (\w+)/;

/** The engine's life in Docker Desktop's backend log (com.docker.backend.exe.log, monitor.log), oldest first. */
export function engineEvents(log: string): EngineEvent[] {
  const out: EngineEvent[] = [];
  for (const raw of log.split(/\r?\n/)) {
    const m = STAMP.exec(raw);
    if (!m) continue;
    const at = Date.parse(`${m[1] as string}.${(m[2] ?? '0').slice(0, 3).padEnd(3, '0')}Z`);
    const line = raw.trim();
    if (IDLE.test(line)) out.push({ at, kind: 'idle', line });
    else {
      const s = STATE.exec(line)?.[1];
      if (s === undefined) continue;
      out.push({ at, kind: s === 'stopping' || s === 'stopped' || s === 'starting' || s === 'running' ? s : 'other', line });
    }
  }
  return out;
}

/** "… setting engine linux/wsl state running -> stopping" without its bulky prefixes, for the expert details. */
function shortLine(line: string): string {
  const cut = line.replace(/^\[[^\]]*\]\s*(?:\[[^\]]*\]\s*)?(?:\[[^\]]*\]\s*)?/, '');
  const at = STAMP.exec(line)?.[1]?.replace('T', ' ') ?? '';
  return `${at} UTC · ${cut}`.slice(0, 200);
}

/**
 * The likely cause from the events: the last "stopping" with nothing after it for over a minute is a
 * stuck stop, Resource Saver's when its "idle" came just before.
 */
export function causeFrom(events: readonly EngineEvent[], now: number): Pick<DockerDiagnosis, 'cause' | 'since' | 'evidence'> | undefined {
  const sorted = [...events].sort((a, b) => a.at - b.at);
  let last = -1;
  for (let i = 0; i < sorted.length; i++) if (sorted[i]!.kind === 'stopping') last = i;
  if (last < 0) return undefined;
  const stop = sorted[last]!;
  // The first "stopping" of this stop (the log says it again while it is stuck).
  let first = last;
  while (first > 0 && sorted[first - 1]!.kind === 'stopping') first--;
  const started = sorted[first]!;
  const after = sorted.slice(last + 1);
  if (after.some((e) => e.kind !== 'idle') || now - stop.at < STOP_STUCK_MS) return undefined;
  const idle = sorted.slice(0, first).reverse().find((e) => e.kind === 'idle' && started.at - e.at <= IDLE_TO_STOP_MS);
  const evidence = [...(idle ? [idle] : []), started, ...(last !== first ? [stop] : [])].map((e) => shortLine(e.line)).slice(0, EVIDENCE_MAX);
  return { cause: idle ? 'resource-saver' : 'stuck-stopping', since: new Date(started.at).toISOString(), evidence };
}

/**
 * Docker Desktop's settings and logs (Windows: %APPDATA%\Docker, %LOCALAPPDATA%\Docker\log\host)
 * turned into the cause the UI explains, and Resource Saver's setting for the advice. `hang` is how
 * LLM Bench itself saw it (no log line: an engine that does not answer).
 */
export async function diagnoseDocker(d: DiagnosisDeps, hang?: DockerHangReason): Promise<DockerDiagnosis> {
  const fallback: DockerDiagnosis = { cause: hang ? 'not-answering' : 'unknown', evidence: [] };
  if (d.platform !== 'win32') return fallback;
  const appData = envValue(d.env, 'APPDATA', 'win32');
  const local = envValue(d.env, 'LOCALAPPDATA', 'win32');
  const settings = appData ? await d.readFile(path.win32.join(appData, 'Docker', 'settings-store.json')).catch(() => undefined) : undefined;
  const resourceSaver = settings === undefined ? undefined : resourceSaverFrom(settings);
  const out: DockerDiagnosis = { ...fallback, ...(resourceSaver ? { resourceSaver } : {}) };
  if (!local) return out;
  const dir = path.win32.join(local, 'Docker', 'log', 'host');
  const logs = await Promise.all(['com.docker.backend.exe.log', 'monitor.log'].map((f) => d.readTail(path.win32.join(dir, f), LOG_TAIL_BYTES).catch(() => '')));
  // Both logs repeat the same lines: one event per moment and kind.
  const seen = new Set<string>();
  const events = logs.flatMap(engineEvents).filter((e) => {
    const key = `${e.at}:${e.kind}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const found = causeFrom(events, d.now());
  return found ? { ...out, ...found } : out;
}

/** The last `bytes` of a file. */
export async function readTail(p: string, bytes: number): Promise<string> {
  const fh = await fs.open(p, 'r');
  try {
    const { size } = await fh.stat();
    const len = Math.min(size, bytes);
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, size - len);
    return buf.toString('utf8');
  } finally {
    await fh.close();
  }
}

/** The real files of this PC (read only). */
export function diagnosisDeps(platform: Platform, env: Record<string, string | undefined>, now: () => number): DiagnosisDeps {
  return { platform, env, readFile: (p) => fs.readFile(p, 'utf8'), readTail, now };
}
