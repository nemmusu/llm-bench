/**
 * TensorRT-LLM's release tags on NGC: "1.2.1" (stable), "1.4.0rc0" and "1.2.0rc6.post2" (release
 * candidates). Nightlies ("1.4.0rc1.dev202610140007"), signatures ("sha256-….sig") and one-off builds
 * ("gb300-ea") are not releases.
 */

export interface TrtllmTagVersion {
  nums: [number, number, number];
  /** The release candidate's number; absent = a stable release. */
  rc?: number;
  post: number;
}

const TAG = /^(\d+)\.(\d+)\.(\d+)(?:rc(\d+))?(?:\.post(\d+))?$/;

export function parseTrtllmTag(tag: string): TrtllmTagVersion | undefined {
  const m = TAG.exec(tag);
  if (!m) return undefined;
  return { nums: [Number(m[1]), Number(m[2]), Number(m[3])], ...(m[4] !== undefined ? { rc: Number(m[4]) } : {}), post: Number(m[5] ?? 0) };
}

export function isTrtllmReleaseTag(tag: string): boolean {
  return parseTrtllmTag(tag) !== undefined;
}

/** < 0 when a is older: version numbers, then rcN before the release, then .postN. Tags that are not releases come first. */
export function compareTrtllmTags(a: string, b: string): number {
  const x = parseTrtllmTag(a);
  const y = parseTrtllmTag(b);
  if (!x || !y) return (x ? 1 : 0) - (y ? 1 : 0);
  for (let i = 0; i < 3; i++) {
    const d = (x.nums[i] as number) - (y.nums[i] as number);
    if (d !== 0) return d;
  }
  const rank = (v: TrtllmTagVersion) => v.rc ?? Number.MAX_SAFE_INTEGER;
  return rank(x) - rank(y) || x.post - y.post;
}

/**
 * The tag "Aggiorna" offers: the newest release tag newer than `current`. A stable release is only
 * followed by stable ones; a release candidate by any newer release (candidate or stable). Undefined
 * when `current` is not a release tag, or nothing is newer.
 */
export function newerTrtllmTag<T extends { name: string }>(current: string, tags: readonly T[]): T | undefined {
  const cur = parseTrtllmTag(current);
  if (!cur) return undefined;
  let best: T | undefined;
  for (const t of tags) {
    const v = parseTrtllmTag(t.name);
    if (!v || (cur.rc === undefined && v.rc !== undefined) || compareTrtllmTags(t.name, current) <= 0) continue;
    if (!best || compareTrtllmTags(t.name, best.name) > 0) best = t;
  }
  return best;
}
