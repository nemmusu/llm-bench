import path from 'node:path';
import type { CoreDeps } from '../deps';

/**
 * Drops model files from the OS page cache before a "cold" load, so the measurement reflects a real
 * disk read. Linux can do it per file without root; Windows needs the opt-in elevated task
 * (see windows-standby.ts). When eviction cannot be guaranteed the run is flagged instead.
 */
export interface EvictResult {
  guaranteed: boolean;
  /** Bytes still resident after eviction, when it could be measured. */
  residentBytesAfter?: number;
  /** Machine-readable reason when not guaranteed. */
  reason?: 'not-supported' | 'not-enabled' | 'failed' | 'still-resident' | 'timeout';
}

export interface CacheEvictor {
  readonly kind: 'linux-fadvise' | 'windows-standby' | 'none';
  evict(files: string[], signal?: AbortSignal): Promise<EvictResult>;
}

export const noEvictor: CacheEvictor = {
  kind: 'none',
  evict: () => Promise.resolve({ guaranteed: false, reason: 'not-supported' }),
};

/** Parses `fincore --bytes --noheadings --output RES <file>` (one number per line). */
export function parseFincore(stdout: string): number | undefined {
  const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
  if (lines.length === 0) return undefined;
  let total = 0;
  for (const line of lines) {
    const n = Number(line.trim().split(/\s+/)[0]);
    if (!Number.isFinite(n)) return undefined;
    total += n;
  }
  return total;
}

/**
 * Linux: `dd if=F iflag=nocache count=0` asks the kernel (posix_fadvise DONTNEED) to drop the file's
 * clean pages, no root needed. `fincore` (util-linux) verifies what is still resident; pages stay
 * resident only if another process maps the file.
 */
export function createLinuxEvictor(deps: Pick<CoreDeps, 'proc'>, opts: { residentTolerance?: number } = {}): CacheEvictor {
  const tolerance = opts.residentTolerance ?? 0.01;
  return {
    kind: 'linux-fadvise',
    async evict(files, signal) {
      let resident = 0;
      let measured = true;
      let size = 0;
      for (const file of files) {
        const dd = await deps.proc.run('dd', [`if=${file}`, 'iflag=nocache', 'count=0', 'status=none'], {
          timeoutMs: 30_000,
          ...(signal ? { signal } : {}),
        });
        if (dd.code !== 0) return { guaranteed: false, reason: 'failed' };
        const st = await deps.proc.run('stat', ['-c', '%s', file], { timeoutMs: 10_000 });
        size += Number(st.stdout.trim()) || 0;
        const fc = await deps.proc.run('fincore', ['--bytes', '--noheadings', '--output', 'RES', file], { timeoutMs: 30_000 });
        const res = fc.code === 0 ? parseFincore(fc.stdout) : undefined;
        if (res === undefined) measured = false;
        else resident += res;
      }
      if (!measured) return { guaranteed: true };
      if (size > 0 && resident / size > tolerance) return { guaranteed: false, residentBytesAfter: resident, reason: 'still-resident' };
      return { guaranteed: true, residentBytesAfter: resident };
    },
  };
}

/** Absolute, normalized file list without duplicates (shards + auxiliaries). */
export function uniqueFiles(files: string[]): string[] {
  return [...new Set(files.map((f) => path.resolve(f)))];
}
