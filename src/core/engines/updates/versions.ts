/**
 * Versions for the update check: release tags of Docker images ("v0.5.21-cu130", "v0.10.1.1") and
 * PyPI releases ("0.11.2", "0.5.0rc1"), compared by their numbers; the newest PyPI release.
 */
import { AppError } from '../../../contract/errors';

export interface ParsedVersion {
  /** Release numbers, then the .postN number (0 without one). */
  nums: number[];
  post: number;
  /** A pre-release (a, b, rc, dev) comes before its release. */
  pre: boolean;
  /** What follows the version in a tag ("-cu130", "-runtime", ""): only tags of the same family compare. */
  family: string;
}

const VERSION = /^v?(\d+(?:\.\d+)*)(?:\.?post(\d+))?((?:a|b|rc|\.?dev)\d*)?(.*)$/i;

export function parseVersion(text: string): ParsedVersion | undefined {
  const m = VERSION.exec(text.trim());
  if (!m) return undefined;
  return { nums: (m[1] as string).split('.').map(Number), post: m[2] === undefined ? 0 : Number(m[2]), pre: m[3] !== undefined, family: m[4] as string };
}

/** < 0 when a is older than b (the families are not looked at). */
export function compareVersions(a: ParsedVersion, b: ParsedVersion): number {
  const n = Math.max(a.nums.length, b.nums.length);
  for (let i = 0; i < n; i++) {
    const d = (a.nums[i] ?? 0) - (b.nums[i] ?? 0);
    if (d !== 0) return d;
  }
  if (a.pre !== b.pre) return a.pre ? -1 : 1;
  return a.post - b.post;
}

/** The newest tag of the same family that is newer than `current` (undefined when there is none, or `current` is not a version). */
export function newerTag<T extends { name: string }>(current: string, tags: readonly T[]): T | undefined {
  const cur = parseVersion(current);
  if (!cur || cur.pre) return undefined;
  let best: { tag: T; v: ParsedVersion } | undefined;
  for (const tag of tags) {
    const v = parseVersion(tag.name);
    if (!v || v.pre || v.family !== cur.family || compareVersions(v, cur) <= 0) continue;
    if (!best || compareVersions(v, best.v) > 0) best = { tag, v };
  }
  return best?.tag;
}

/** "vllm", "sglang[all]>=0.5" → the package name ("sglang") and its extras ("[all]"). */
export function packageOf(spec: string): { name: string; extras: string } {
  const m = /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)(\[[^\]]*\])?/.exec(spec);
  return m ? { name: m[1] as string, extras: m[2] ?? '' } : { name: spec.trim(), extras: '' };
}

export interface PypiRelease {
  version: string;
  /** Size of the release's wheel for Linux x86_64 (the biggest file when no wheel says its platform). */
  sizeBytes?: number;
}

interface PypiJson {
  info?: { version?: unknown };
  urls?: { filename?: unknown; size?: unknown; packagetype?: unknown }[];
}

/** The newest release of a PyPI package (its JSON API). */
export async function pypiLatest(fetchImpl: typeof globalThis.fetch, baseUrl: string, name: string, signal?: AbortSignal): Promise<PypiRelease> {
  const url = `${baseUrl.replace(/\/+$/, '')}/pypi/${encodeURIComponent(name)}/json`;
  let res: Response;
  try {
    res = await fetchImpl(url, { headers: { accept: 'application/json' }, ...(signal ? { signal } : {}) });
  } catch (e) {
    throw new AppError('NETWORK', `PyPI is not reachable: ${String(e)}`, { cause: e, params: { service: 'pypi' } });
  }
  if (!res.ok) throw new AppError('NETWORK', `PyPI answered ${res.status}`, { params: { status: res.status, service: 'pypi', reason: 'http' } });
  const body = (await res.json()) as PypiJson;
  const version = body.info?.version;
  if (typeof version !== 'string' || version === '') throw new AppError('NETWORK', `PyPI has no version for ${name}`, { params: { service: 'pypi', reason: 'no-version' } });
  const files = (body.urls ?? []).filter((f): f is { filename: string; size: number } => typeof f.filename === 'string' && typeof f.size === 'number');
  const linux = files.filter((f) => /manylinux[^/]*x86_64\.whl$/.test(f.filename));
  const pool = linux.length > 0 ? linux : files;
  const size = pool.reduce<number | undefined>((m, f) => (m === undefined || f.size > m ? f.size : m), undefined);
  return { version, ...(size !== undefined ? { sizeBytes: size } : {}) };
}
