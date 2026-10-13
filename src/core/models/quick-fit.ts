import { precisionFromText } from '../../contract/formats';
import { ninferFit } from '../../contract/ninfer';
import type { HubModel, QuickFit } from '../../contract/models';
import type { CuratedModel } from './curated';
import { estimateFit, levelRank } from './fit';
import { bytesPerParam } from './quant';
import type { HubFormat } from './hub';
import type { GpuMem } from './types';

/** Precision a safetensors repo ships in (the search result's, else from its name and tags); BF16 otherwise. */
export function safetensorsQuant(m: Pick<HubModel, 'name' | 'tags'> & { precision?: HubModel['precision'] }): string {
  return m.precision ?? precisionFromText(m.name, ...m.tags) ?? 'BF16';
}

type Family = QuickFit['engine'];

/**
 * How a format is judged: GGUF at Q4_K_M on llama.cpp; safetensors at their precision on vLLM (SGLang
 * reserves memory the same way). NInfer artifacts go through NInfer's own estimate (quickFit).
 */
function target(family: Family, quant: string) {
  // NInfer's hub-size bound uses llama.cpp's math (the card bound only; each result is judged by ninferFit).
  if (family === 'llamacpp' || family === 'ninfer') return { quant: 'Q4_K_M', engine: 'llamacpp-native', family } as const;
  return { quant, engine: 'vllm-docker', family } as const;
}

/** The format a search result is judged in: the one the filter asks for, else GGUF, safetensors, NInfer in this order. */
function familyOf(m: Pick<HubModel, 'formats'>, format: HubFormat): Family {
  if (format === 'gguf') return 'llamacpp';
  if (format === 'safetensors') return 'vllm';
  if (format === 'ninfer') return 'ninfer';
  if (m.formats.includes('gguf')) return 'llamacpp';
  return !m.formats.includes('safetensors') && m.formats.includes('ninfer') ? 'ninfer' : 'vllm';
}

/**
 * VRAM verdict of a search result from its parameter count only: no file or header reads, so a
 * whole page of results gets badges at once. GGUF repos are judged at Q4_K_M (what the download
 * dialog usually preselects), safetensors repos at their own precision on vLLM, NInfer artifacts at theirs.
 */
export function quickFit(m: HubModel, gpu: GpuMem, format: HubFormat = 'any'): QuickFit | undefined {
  if (m.paramsB === undefined) return undefined;
  // Only formats LLM Bench cannot run (an MLX repo): no verdict to give.
  if (format === 'any' && m.formats.length > 0 && m.formats.every((f) => f === 'other')) return undefined;
  const family = familyOf(m, format);
  if (family === 'ninfer') {
    // NInfer's own estimate on an artifact the size the parameters and precision suggest (search results carry no file sizes).
    const quant = precisionFromText(m.name) ?? 'NVFP4';
    const est = ninferFit({ artifactBytes: m.paramsB * 1e9 * bytesPerParam(quant), label: m.name, gpu });
    return { level: est.level, needMiB: est.needMiB, availableMiB: est.availableMiB, quant, engine: 'ninfer' };
  }
  const t = target(family, safetensorsQuant(m));
  const est = estimateFit({ facts: { paramsB: m.paramsB, quant: t.quant }, gpu, engine: t.engine });
  return { level: est.level, needMiB: est.needMiB, availableMiB: est.availableMiB, quant: t.quant, engine: t.family };
}

/** Whether a quick verdict counts as "fits" for the filter: entirely in VRAM, even if tight. */
export function quickFits(fit: QuickFit | undefined): boolean {
  return fit !== undefined && levelRank(fit.level) <= levelRank('tight');
}

/**
 * Largest parameter count (billions) that still fits at a 4-bit quant: the size bound sent to the
 * hub for "only models that fit", so pages come back full. Each result is still judged on its own.
 */
export function maxFittingParamsB(gpu: GpuMem, format: HubFormat): number {
  const t = target(format === 'safetensors' ? 'vllm' : format === 'ninfer' ? 'ninfer' : 'llamacpp', 'AWQ');
  const fits = (paramsB: number) => levelRank(estimateFit({ facts: { paramsB, quant: t.quant }, gpu, engine: t.engine }).level) <= levelRank('tight');
  if (!fits(0.001)) return 0;
  let lo = 0;
  let hi = 4096;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (fits(mid)) lo = mid;
    else hi = mid;
  }
  return lo;
}

/** Curated entries know their exact file size: weights are exact, only the KV cache is estimated. */
export function curatedFit(m: CuratedModel, gpu: GpuMem): QuickFit {
  const est = estimateFit({ facts: { paramsB: m.paramsB, quant: m.quant }, fileBytes: m.sizeBytes, gpu, engine: m.engine === 'llamacpp' ? 'llamacpp-native' : 'vllm-docker' });
  return { level: est.level, needMiB: est.needMiB, availableMiB: est.availableMiB, quant: m.quant, engine: m.engine };
}

/** Hub pipelines a text benchmark can run (vision-language models answer text prompts too). */
const LLM_PIPELINES = new Set(['text-generation', 'image-text-to-text', 'text2text-generation', 'any-to-any', 'visual-question-answering', 'video-text-to-text', 'audio-text-to-text']);

/** Whether a repo is a language model: image generators, speech, embeddings… cannot be benchmarked here. Untagged repos are kept. */
export function isLanguageModel(m: Pick<HubModel, 'pipelineTag'>): boolean {
  return m.pipelineTag === undefined || LLM_PIPELINES.has(m.pipelineTag);
}
