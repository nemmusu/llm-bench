import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { AppError } from '../../contract/errors';
import {
  RESULT_SCHEMA_VERSION,
  runResultSchema,
  type LatencyPoint,
  type RunResult,
  type RunSummary,
} from '../../contract/results';
import { readJsonFile, writeFileAtomic } from './atomic';

export const EXPORT_FORMAT = 'gpubench-export';
export const EXPORT_VERSION = 1;

/** `.gpubench` export file: a list of complete runs. */
export interface ExportBundle {
  format: typeof EXPORT_FORMAT;
  version: number;
  runs: RunResult[];
}

const bundleSchema = z.object({
  format: z.literal(EXPORT_FORMAT),
  version: z.number().int(),
  runs: z.array(z.unknown()),
});

/** Where "this PC + this GPU" is, to rank results for the "Provato su questa GPU" badge. */
export interface HereIdentity {
  hostId: string;
  gpuUuid?: string;
  gpuName?: string;
}

/**
 * Lenient parse of a stored run: newer schema versions are skipped (an older app on a shared
 * folder must not choke on them), unknown fields are dropped, invalid content gives null.
 */
export function parseRun(raw: unknown): RunResult | null {
  if (!raw || typeof raw !== 'object') return null;
  const version = (raw as { schema?: unknown }).schema;
  if (typeof version === 'number' && version > RESULT_SCHEMA_VERSION) return null;
  const parsed = runResultSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/** The latency point the headline numbers come from: 512-token prompt, else the first one. */
function headlinePoint(latency: readonly LatencyPoint[]): LatencyPoint | undefined {
  return latency.find((p) => p.promptTokens === 512) ?? latency[0];
}

/** Lightweight row for lists and badges. `file` is the file's base name inside the results folder. */
export function summaryOf(run: RunResult, file: string): RunSummary {
  const m = run.metrics;
  const head = headlinePoint(m.latency);
  const largest = [...m.latency].sort((a, b) => b.promptTokens - a.promptTokens)[0];
  const gpu = run.hardware.gpus[0];
  const e = run.engine;
  const release = e.build ?? e.version;
  const engineLabel = `${e.name}${release ? ` ${release}` : ''}${e.variant ? ` (${e.variant})` : ''}`;
  const prefill = largest ? (largest.prefillTpsEngine ?? largest.prefillTps).median : undefined;
  const vramMiB = m.vram.deltaMiB ?? m.vram.peakMiB;
  return {
    id: run.id,
    createdAt: run.createdAt,
    status: run.status,
    profile: run.scenario.profile,
    modelName: run.model.displayName,
    modelWeakKey: run.model.weakKey,
    ...(run.model.sha256 ? { modelSha256: run.model.sha256 } : {}),
    ...(run.model.quant ? { quant: run.model.quant } : {}),
    engineKind: e.kind,
    engineLabel,
    gpuName: gpu?.name ?? 'unknown',
    ...(gpu?.uuid ? { gpuUuid: gpu.uuid } : {}),
    hostId: run.hardware.hostId,
    hostLabel: run.hardware.hostLabel,
    ...(head && head.decodeTps.n > 0 ? { decodeTps: head.decodeTps.median } : {}),
    ...(prefill ? { prefillTps: prefill } : {}),
    ...(head && head.ttftMs.n > 0 ? { ttftMs: head.ttftMs.median } : {}),
    ...(m.load.coldMs ? { coldLoadMs: m.load.coldMs.median } : {}),
    ...(m.load.warmMs ? { warmLoadMs: m.load.warmMs.median } : {}),
    ...(vramMiB !== undefined ? { vramPeakMiB: vramMiB } : {}),
    ...(m.score ? { score: m.score.value } : {}),
    validity: run.validity,
    file,
  };
}

/** `YYYY-MM-DD_HH-mm-ss` in UTC, so names sort the same on every PC sharing the folder. */
export function fileStamp(iso: string): string {
  const parsed = new Date(iso);
  const d = Number.isNaN(parsed.getTime()) ? new Date(0) : parsed;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}_${p(d.getUTCHours())}-${p(d.getUTCMinutes())}-${p(d.getUTCSeconds())}`;
}

const safeName = (id: string): string => id.replace(/[^A-Za-z0-9-]/g, '_').slice(0, 64);

function newestFirst(a: RunSummary, b: RunSummary): number {
  const ta = Date.parse(a.createdAt) || 0;
  const tb = Date.parse(b.createdAt) || 0;
  if (ta !== tb) return tb - ta;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

async function exists(file: string): Promise<boolean> {
  return fs.access(file).then(
    () => true,
    () => false,
  );
}

/** Runs `fn` over `items` with at most `limit` in flight (a big shared folder over SMB is slow). */
async function forEachLimit<T>(items: readonly T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await fn(items[next++] as T);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

interface CacheEntry {
  mtimeMs: number;
  size: number;
  summary: RunSummary | null;
}

/**
 * One JSON file per run in the results folder, which can be shared or synced between PCs:
 * names are unique and a file is never rewritten, so two PCs never conflict.
 */
export class RunsRepo {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly resolveDir: () => string | Promise<string>;

  /** `resolveDir` is called on every operation: the folder comes from settings and can change. */
  constructor(resolveDir: () => string | Promise<string>) {
    this.resolveDir = resolveDir;
  }

  async dir(): Promise<string> {
    return path.resolve(await this.resolveDir());
  }

  /** Validates and writes `<YYYY-MM-DD_HH-mm-ss>_<id>.json` atomically; never overwrites. Returns the path. */
  async save(run: RunResult): Promise<string> {
    const valid = runResultSchema.parse(run);
    const dir = await this.dir();
    const base = `${fileStamp(valid.createdAt)}_${safeName(valid.id)}`;
    let file = path.join(dir, `${base}.json`);
    for (let i = 2; await exists(file); i++) file = path.join(dir, `${base}_${i}.json`);
    await writeFileAtomic(file, JSON.stringify(valid));
    return file;
  }

  /** Every readable run, newest first. Unchanged files (same mtime and size) are not re-read. */
  async list(): Promise<RunSummary[]> {
    const dir = await this.dir();
    let names: string[];
    try {
      names = (await fs.readdir(dir)).filter((n) => n.toLowerCase().endsWith('.json'));
    } catch {
      return [];
    }
    const present = new Set(names.map((n) => path.join(dir, n)));
    for (const key of this.cache.keys()) if (path.dirname(key) === dir && !present.has(key)) this.cache.delete(key);
    const out: RunSummary[] = [];
    await forEachLimit([...present], 16, async (file) => {
      const s = await this.summaryFor(file);
      if (s) out.push(s);
    });
    return out.sort(newestFirst);
  }

  private async summaryFor(file: string): Promise<RunSummary | null> {
    let st: { mtimeMs: number; size: number; isFile(): boolean };
    try {
      st = await fs.stat(file);
    } catch {
      return null;
    }
    if (!st.isFile()) return null;
    const hit = this.cache.get(file);
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.summary;
    const run = parseRun(await readJsonFile(file).catch(() => null));
    const summary = run ? summaryOf(run, path.basename(file)) : null;
    this.cache.set(file, { mtimeMs: st.mtimeMs, size: st.size, summary });
    return summary;
  }

  /** Path of the run's file; only files directly inside the current results folder are considered. */
  private async fileOf(id: string): Promise<string | undefined> {
    await this.list();
    const dir = await this.dir();
    for (const [file, entry] of this.cache) {
      if (entry.summary?.id === id && path.dirname(file) === dir) return file;
    }
    return undefined;
  }

  async get(id: string): Promise<RunResult | undefined> {
    const file = await this.fileOf(id);
    if (!file) return undefined;
    return parseRun(await readJsonFile(file).catch(() => null)) ?? undefined;
  }

  /** Deletes the run's file. false when the id is unknown. */
  async delete(id: string): Promise<boolean> {
    const file = await this.fileOf(id);
    if (!file) return false;
    await fs.rm(file, { force: true });
    this.cache.delete(file);
    return true;
  }

  /**
   * Results for a model (sha256 match, or weak key): this PC + GPU first, then the same GPU model
   * (or card) elsewhere, then the rest; newest first inside each group. All statuses are returned
   * (a failed attempt is useful information); callers filter.
   */
  async tried(model: { sha256?: string; weakKey: string }, here: HereIdentity): Promise<RunSummary[]> {
    const rank = (s: RunSummary): number => {
      const sameCard = !here.gpuUuid || !s.gpuUuid || s.gpuUuid === here.gpuUuid;
      if (s.hostId === here.hostId && sameCard) return 0;
      if ((here.gpuUuid && s.gpuUuid === here.gpuUuid) || (here.gpuName && s.gpuName === here.gpuName)) return 1;
      return 2;
    };
    const matches = (await this.list()).filter(
      (s) => (model.sha256 !== undefined && s.modelSha256 === model.sha256) || s.modelWeakKey === model.weakKey,
    );
    // Array.prototype.sort is stable: newest-first order is kept inside each rank.
    return matches.sort((a, b) => rank(a) - rank(b));
  }

  async exportRuns(ids: readonly string[]): Promise<ExportBundle> {
    const runs: RunResult[] = [];
    for (const id of ids) {
      const run = await this.get(id);
      if (run) runs.push(run);
    }
    return { format: EXPORT_FORMAT, version: EXPORT_VERSION, runs };
  }

  /** Writes the bundle's runs that are not already present (by id); invalid or newer runs are skipped. */
  async importBundle(json: unknown): Promise<{ imported: number; skipped: number }> {
    const parsed = bundleSchema.safeParse(json);
    if (!parsed.success) throw new AppError('VALIDATION', 'Not a GPU Bench export file', { params: { reason: 'not_export' } });
    if (parsed.data.version > EXPORT_VERSION) {
      throw new AppError('VALIDATION', 'Export file from a newer GPU Bench', {
        params: { reason: 'export_too_new', version: parsed.data.version },
      });
    }
    const known = new Set((await this.list()).map((s) => s.id));
    let imported = 0;
    let skipped = 0;
    for (const raw of parsed.data.runs) {
      const run = parseRun(raw);
      if (!run || known.has(run.id)) {
        skipped++;
        continue;
      }
      await this.save(run);
      known.add(run.id);
      imported++;
    }
    return { imported, skipped };
  }
}
