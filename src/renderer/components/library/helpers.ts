import type { GpuInfo } from '../../../contract/hardware';
import type { HubFile, HubModel } from '../../../contract/models';
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

/** Repos already benchmarked on this GPU (weak keys start with the repo id). */
export function triedRepos(runs: readonly RunSummary[] | undefined, gpu: Pick<GpuInfo, 'uuid' | 'name'> | undefined): Set<string> {
  const out = new Set<string>();
  for (const r of runs ?? []) {
    if (!gpu || (r.gpuUuid !== gpu.uuid && r.gpuName !== gpu.name)) continue;
    const parts = r.modelWeakKey.split('/');
    if (parts.length >= 5) out.add(`${parts[0]}/${parts[1]}`);
  }
  return out;
}

export type SizeBucket = 'any' | 'small' | 'medium' | 'large' | 'huge';

/** Parameter-count buckets of the search filter (billions). */
export const SIZE_BUCKETS: Record<Exclude<SizeBucket, 'any'>, [number, number]> = {
  small: [0, 4.5],
  medium: [4.5, 15],
  large: [15, 40],
  huge: [40, Infinity],
};

export function inBucket(paramsB: number | undefined, bucket: SizeBucket): boolean {
  if (bucket === 'any') return true;
  if (paramsB === undefined) return false;
  const [lo, hi] = SIZE_BUCKETS[bucket];
  return paramsB >= lo && paramsB < hi;
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

/** Search hits that are conversions of the same base model sit together under it. */
export function groupByBase(models: readonly HubModel[]): { base: string | undefined; models: HubModel[] }[] {
  const out: { base: string | undefined; models: HubModel[] }[] = [];
  const index = new Map<string, number>();
  for (const m of models) {
    const base = m.baseModel && m.baseModel !== m.repo ? m.baseModel : undefined;
    const at = base === undefined ? undefined : index.get(base);
    if (at !== undefined) (out[at] as { models: HubModel[] }).models.push(m);
    else {
      if (base !== undefined) index.set(base, out.length);
      out.push({ base, models: [m] });
    }
  }
  return out;
}

/** "Q4_K_M/Demo-Q4_K_M-00001-of-00002.gguf" → "Demo-Q4_K_M-00001-of-00002.gguf". */
export function fileName(p: string): string {
  return p.split(/[\\/]/).pop() as string;
}
