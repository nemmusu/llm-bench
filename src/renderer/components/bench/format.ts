/** Small, pure helpers shared by the benchmark screens and the exports. */
import type { EngineIdentity, LatencyPoint, Metrics, RunResult } from '../../../contract/results';
import type { ModelIdentity } from '../../../contract/models';

export const MIB_PER_GB = 1024;

/** "cuda-13.4" → "CUDA 13.4", "cpu" → "CPU"; anything else unchanged. */
export function prettyVariant(variant: string): string {
  const m = /^(cuda|cpu|vulkan|rocm|hip)[-_ ]?(.*)$/i.exec(variant);
  if (!m) return variant;
  return [m[1]!.toUpperCase(), m[2]].filter(Boolean).join(' ');
}

/** "llama.cpp b11438 (CUDA 13.4)", "vLLM v0.12.0". */
export function engineLabelOf(engine: Pick<EngineIdentity, 'name' | 'build' | 'version' | 'variant'>): string {
  const release = engine.build ?? engine.version;
  return `${engine.name}${release ? ` ${release}` : ''}${engine.variant ? ` (${prettyVariant(engine.variant)})` : ''}`;
}

/** Display name plus quant, without repeating the quant when the name already has it. */
export function modelLabelOf(model: Pick<ModelIdentity, 'displayName' | 'quant'>): string {
  const { displayName, quant } = model;
  if (!quant || displayName.toLowerCase().includes(quant.toLowerCase())) return displayName;
  return `${displayName} · ${quant}`;
}

/** The latency point the headline numbers come from: 512-token prompt, else the first one. */
export function headlinePoint(latency: readonly LatencyPoint[]): LatencyPoint | undefined {
  return latency.find((p) => p.promptTokens === 512) ?? latency[0];
}

export interface VramFigure {
  mib: number;
  /** Measured as total-minus-baseline: other programs may have moved it. */
  approximate: boolean;
}

/** Prompt-reading speed: the engine's own figure when it reports one (more precise), else client-side. */
export function prefillStat(p: LatencyPoint): LatencyPoint['prefillTps'] {
  return p.prefillTpsEngine ?? p.prefillTps;
}

/** The engine's own peak when the OS could attribute it, otherwise total-minus-baseline. */
export function vramFigure(vram: Metrics['vram']): VramFigure | undefined {
  if (vram.method === 'process' && vram.processPeakMiB !== undefined) return { mib: vram.processPeakMiB, approximate: false };
  const mib = vram.deltaMiB ?? vram.peakMiB;
  return mib === undefined ? undefined : { mib, approximate: true };
}

/** Peak aggregate throughput over the concurrency levels. */
export function peakConcurrency(run: Pick<RunResult, 'metrics'>) {
  const points = run.metrics.concurrency;
  return points.length ? points.reduce((best, p) => (p.aggregateTps > best.aggregateTps ? p : best)) : undefined;
}

/** "NVIDIA GeForce RTX 5090" → "RTX 5090". */
export function shortGpuName(name: string): string {
  return name.replace(/^NVIDIA\s+(GeForce\s+)?/i, '');
}

/** True when `exe` lives inside the folder where LLM Bench installs engines (a managed build). */
export function isManagedExecutable(exe: string, enginesDir: string | undefined): boolean {
  if (!enginesDir) return false;
  const norm = (p: string) => p.replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase();
  return norm(exe).startsWith(`${norm(enginesDir)}/`);
}

/** File-system friendly slug for export file names. */
export function slug(text: string): string {
  return (
    text
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^A-Za-z0-9._-]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 60) || 'run'
  );
}

/** The singular message for exactly one item, the plural one otherwise. */
export function countKey<K extends string>(n: number, one: K, other: K): K {
  return n === 1 ? one : other;
}

/** "llama.cpp b11438 (cuda-13.4)" (a RunSummary label) → "llama.cpp b11438 (CUDA 13.4)". */
export function prettyEngineLabel(label: string): string {
  return label.replace(/\(([^)]+)\)$/, (_, v: string) => `(${prettyVariant(v)})`);
}

/**
 * The same without the build's backend, for a narrow list: "llama.cpp b11438 (cuda-13.4)" →
 * "llama.cpp b11438". A name of its own in brackets stays ("PrismML (git)").
 */
export function shortEngineLabel(label: string): string {
  return label.replace(/\s+\((?:cuda|cpu|vulkan|rocm|hip)\b[^)]*\)$/i, '');
}

/** Model name plus quant for a list row, without repeating the quant. */
export function summaryModelLabel(r: { modelName: string; quant?: string | undefined }): string {
  return modelLabelOf({ displayName: r.modelName, quant: r.quant });
}
