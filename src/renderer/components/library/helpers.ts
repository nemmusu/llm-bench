import type { GpuInfo } from '../../../contract/hardware';
import type { HubFile } from '../../../contract/models';
import type { RunSummary } from '../../../contract/results';
import type { CuratedModel } from '../../../contract/views';

export const HF_BASE = 'https://huggingface.co';

/** The model's page on Hugging Face (license, files, discussions). */
export function repoUrl(repo: string): string {
  return `${HF_BASE}/${repo}`;
}

/** Same format as the core's weakKey(): repo/file/quant/size (a local download gets exactly this key). */
export function remoteWeakKey(repo: string, file: string, quant: string | undefined, sizeBytes: number): string {
  return `${repo}/${file.split('/').pop() as string}/${quant ?? ''}/${sizeBytes}`;
}

export function curatedWeakKey(m: Pick<CuratedModel, 'repo' | 'file' | 'quant' | 'sizeBytes'>): string {
  return remoteWeakKey(m.repo, m.file ?? '', m.quant, m.sizeBytes);
}

export interface TriedHere {
  tps: number;
  date: string;
  runId: string;
}

/** Best completed run on this GPU (same card, or the same model of card), by generation speed. */
export function bestRunHere(runs: readonly RunSummary[] | undefined, gpu: Pick<GpuInfo, 'uuid' | 'name'> | undefined): TriedHere | undefined {
  let best: RunSummary | undefined;
  for (const r of runs ?? []) {
    if (r.status !== 'completed' || r.decodeTps === undefined || !gpu) continue;
    if (r.gpuUuid !== gpu.uuid && r.gpuName !== gpu.name) continue;
    if (!best || r.decodeTps > (best.decodeTps as number)) best = r;
  }
  return best ? { tps: best.decodeTps as number, date: best.createdAt, runId: best.id } : undefined;
}

export interface TriedModel {
  repo: string;
  owner: string;
  name: string;
  quant: string | undefined;
  /** Best generation speed on this GPU, when a run completed. */
  tps: number | undefined;
  /** Latest run. */
  date: string;
  runs: number;
}

/** Hub models benchmarked on this GPU, one per repo, most recent first (weak keys start with the repo id). */
export function triedModels(runs: readonly RunSummary[] | undefined, gpu: Pick<GpuInfo, 'uuid' | 'name'> | undefined): TriedModel[] {
  const out = new Map<string, TriedModel>();
  for (const r of runs ?? []) {
    const parts = r.modelWeakKey.split('/');
    if (!gpu || parts.length < 5 || (r.gpuUuid !== gpu.uuid && r.gpuName !== gpu.name)) continue;
    const repo = `${parts[0]}/${parts[1]}`;
    const tps = r.status === 'completed' ? r.decodeTps : undefined;
    const seen = out.get(repo);
    if (!seen) {
      out.set(repo, { repo, owner: parts[0] as string, name: parts[1] as string, quant: r.quant, tps, date: r.createdAt, runs: 1 });
      continue;
    }
    seen.runs++;
    if (r.createdAt > seen.date) seen.date = r.createdAt;
    if (tps !== undefined && (seen.tps === undefined || tps > seen.tps)) {
      seen.tps = tps;
      seen.quant = r.quant;
    }
  }
  return [...out.values()].sort((a, b) => b.date.localeCompare(a.date));
}

export type SizeBucket = 'any' | 'small' | 'medium' | 'large' | 'huge';

/** Parameter-count buckets of the search filter (billions). */
export const SIZE_BUCKETS: Record<Exclude<SizeBucket, 'any'>, [number, number]> = {
  small: [0, 4.5],
  medium: [4.5, 15],
  large: [15, 40],
  huge: [40, Infinity],
};

/** A size bucket as the catalog's parameter range (open ends left out). */
export function bucketRange(bucket: SizeBucket): { minParamsB?: number; maxParamsB?: number } {
  if (bucket === 'any') return {};
  const [lo, hi] = SIZE_BUCKETS[bucket];
  return { ...(lo > 0 ? { minParamsB: lo } : {}), ...(Number.isFinite(hi) ? { maxParamsB: hi } : {}) };
}

export interface FileGroup {
  /** Quantization label, or the file kind for extras (mmproj, config…). */
  label: string;
  kind: HubFile['kind'];
  files: HubFile[];
  sizeBytes: number;
}

/** Repo files grouped the way people think of them: one row per quant (split parts together), extras after. */
export function groupFiles(files: readonly HubFile[]): FileGroup[] {
  const groups = new Map<string, FileGroup>();
  for (const f of files) {
    const weights = f.kind === 'weights';
    const key = weights ? (f.groupKey ?? f.quant ?? f.path) : `~${f.kind}`;
    const label = weights ? (f.quant ?? (f.path.split('/').pop() as string)) : f.kind;
    const g = groups.get(key) ?? { label, kind: f.kind, files: [], sizeBytes: 0 };
    g.files.push(f);
    g.sizeBytes += f.sizeBytes;
    groups.set(key, g);
  }
  return [...groups.values()].sort((a, b) => Number(a.kind !== 'weights') - Number(b.kind !== 'weights') || b.sizeBytes - a.sizeBytes);
}

/** "Q4_K_M/Demo-Q4_K_M-00001-of-00002.gguf" → "Demo-Q4_K_M-00001-of-00002.gguf". */
export function fileName(p: string): string {
  return p.split(/[\\/]/).pop() as string;
}
