import type { HubModel, QuickFit } from '../../contract/models';
import type { CuratedModel } from './curated';
import { estimateFit, levelRank } from './fit';
import type { HubFormat } from './hub';
import type { GpuMem } from './types';

/** Precision a safetensors repo ships in, from its name and tags (AWQ, FP8…); BF16 otherwise. */
export function safetensorsQuant(m: Pick<HubModel, 'name' | 'tags'>): string {
  const text = `${m.name} ${m.tags.join(' ')}`.toUpperCase();
  if (/NVFP4|MXFP4/.test(text)) return 'MXFP4';
  if (/\bAWQ\b|GPTQ|INT4|W4A16|4BIT|BNB/.test(text)) return 'AWQ';
  if (/FP8|INT8|W8A8|8BIT/.test(text)) return 'FP8';
  return 'BF16';
}

function target(gguf: boolean, quant: string) {
  return gguf ? ({ quant: 'Q4_K_M', engine: 'llamacpp-native', family: 'llamacpp' } as const) : ({ quant, engine: 'vllm-docker', family: 'vllm' } as const);
}

/**
 * VRAM verdict of a search result from its parameter count only: no file or header reads, so a
 * whole page of results gets badges at once. GGUF repos are judged at Q4_K_M (what the download
 * dialog usually preselects), safetensors repos at their own precision on vLLM.
 */
export function quickFit(m: HubModel, gpu: GpuMem, format: HubFormat = 'any'): QuickFit | undefined {
  if (m.paramsB === undefined) return undefined;
  const gguf = format === 'gguf' || (format !== 'safetensors' && m.formats.includes('gguf'));
  const t = target(gguf, safetensorsQuant(m));
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
  const t = target(format !== 'safetensors', 'AWQ');
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
