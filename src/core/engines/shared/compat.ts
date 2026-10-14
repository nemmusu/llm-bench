import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

/** TensorRT-LLM's release image on NVIDIA's registry (NGC), and the tag its docs install (checked 2026-10-14). */
export const TRTLLM_IMAGE = 'nvcr.io/nvidia/tensorrt-llm/release';
export const TRTLLM_RECOMMENDED_TAG = '1.4.0rc0';

/** resources/engine-compat.json: which engine images work on which GPUs (facts with sources). */
export const engineCompatSchema = z.object({
  schema: z.literal(1),
  updated: z.string(),
  vllm: z.object({
    image: z.string(),
    recommendedTag: z.string(),
    /** First tag whose image has kernels for this architecture ("sm_120" → "v0.9.2"). */
    minTagBySm: z.record(z.string(), z.string()),
    /** Last tag that still has kernels for an architecture dropped later. */
    maxTagBySm: z.record(z.string(), z.string()).default({}),
    /** From this tag the entrypoint is `vllm serve` and the model is a positional argument. */
    positionalModelFromTag: z.string(),
    cudaByTag: z.array(z.object({ fromTag: z.string(), cuda: z.string() })).default([]),
    notes: z.array(z.string()).default([]),
  }),
  llamacpp: z.object({
    dockerImage: z.string(),
    dockerImageCuda13: z.string().optional(),
    notes: z.array(z.string()).default([]),
  }),
  /** lmsysorg/sglang: the release tag offered by default (files without the section get the built-in one). */
  sglang: z
    .object({
      image: z.string(),
      recommendedTag: z.string(),
      notes: z.array(z.string()).default([]),
    })
    .default({ image: 'lmsysorg/sglang', recommendedTag: 'v0.5.21', notes: [] }),
  /**
   * NVIDIA TensorRT-LLM's NGC image (nvcr.io/nvidia/tensorrt-llm/release): the tag offered by default
   * (files without the section get the built-in one).
   */
  trtllm: z
    .object({
      image: z.string(),
      recommendedTag: z.string(),
      notes: z.array(z.string()).default([]),
    })
    .default({ image: TRTLLM_IMAGE, recommendedTag: TRTLLM_RECOMMENDED_TAG, notes: [] }),
  minDriverByCuda: z.record(z.string(), z.object({ linux: z.string(), windows: z.string() })).default({}),
  sources: z.array(z.object({ url: z.string(), fact: z.string(), checked: z.string() })).default([]),
});
export type EngineCompat = z.infer<typeof engineCompatSchema>;

/** Used when the resource file is missing or invalid, so Docker engines still have sane defaults. */
export const BUILTIN_COMPAT: EngineCompat = {
  schema: 1,
  updated: '2026-10-06',
  vllm: {
    image: 'vllm/vllm-openai',
    recommendedTag: 'v0.31.0',
    minTagBySm: { sm_120: 'v0.9.2' },
    maxTagBySm: {},
    positionalModelFromTag: 'v0.12.0',
    cudaByTag: [],
    notes: [],
  },
  llamacpp: { dockerImage: 'ghcr.io/ggml-org/llama.cpp:server-cuda', notes: [] },
  sglang: { image: 'lmsysorg/sglang', recommendedTag: 'v0.5.21', notes: [] },
  trtllm: { image: TRTLLM_IMAGE, recommendedTag: TRTLLM_RECOMMENDED_TAG, notes: [] },
  minDriverByCuda: {},
  sources: [],
};

export async function loadEngineCompat(resourcesDir: string): Promise<EngineCompat> {
  try {
    const raw: unknown = JSON.parse(await fs.readFile(path.join(resourcesDir, 'engine-compat.json'), 'utf8'));
    const parsed = engineCompatSchema.safeParse(raw);
    return parsed.success ? parsed.data : BUILTIN_COMPAT;
  } catch {
    return BUILTIN_COMPAT;
  }
}

/** "12.0" (nvidia-smi compute_cap) → "sm_120". */
export function smFromComputeCap(cc: string): string | undefined {
  const m = /^(\d+)\.(\d+)$/.exec(cc.trim());
  return m ? `sm_${m[1] as string}${m[2] as string}` : undefined;
}

/** "v0.9.2", "v0.9.0.1", "v0.31.0-cu129" → numeric parts; undefined for latest/nightly/custom tags. */
export function parseVllmTag(tag: string): number[] | undefined {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:\.(\d+))?(?:[-+].*)?$/.exec(tag);
  if (!m) return undefined;
  return [m[1], m[2], m[3], m[4] ?? '0'].map(Number);
}

/** Orders two parsed versions (missing parts count as 0). */
export function compareVersions(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return Math.sign(d);
  }
  return 0;
}

/** Tag of a vllm/vllm-openai reference, undefined for other images or digests. */
export function vllmTagOf(image: string, compat: EngineCompat): string | undefined {
  const at = image.indexOf('@');
  const ref = at >= 0 ? image.slice(0, at) : image;
  const colon = ref.lastIndexOf(':');
  const hasTag = colon > ref.lastIndexOf('/');
  const repo = (hasTag ? ref.slice(0, colon) : ref).replace(/^(?:docker\.io|index\.docker\.io)\//, '');
  if (repo !== compat.vllm.image) return undefined;
  if (hasTag) return ref.slice(colon + 1);
  return at >= 0 ? undefined : 'latest';
}

/**
 * Does the image's vLLM version have kernels for `sm`? true/false when the tag is a version and
 * the table knows the architecture, undefined otherwise (nightly, custom images, unknown GPUs).
 */
export function vllmTagSupportsSm(compat: EngineCompat, tag: string, sm: string): boolean | undefined {
  const v = parseVllmTag(tag);
  if (!v) return undefined;
  const min = compat.vllm.minTagBySm[sm];
  const max = compat.vllm.maxTagBySm[sm];
  const minV = min === undefined ? undefined : parseVllmTag(min);
  const maxV = max === undefined ? undefined : parseVllmTag(max);
  if (!minV && !maxV) return undefined;
  if (minV && compareVersions(v, minV) < 0) return false;
  if (maxV && compareVersions(v, maxV) > 0) return false;
  return true;
}

/** Tag to propose after "no kernel image": the recommended tag when it fits the GPU, else the table minimum. */
export function suggestVllmTag(compat: EngineCompat, sm?: string): string {
  const rec = compat.vllm.recommendedTag;
  if (sm === undefined || vllmTagSupportsSm(compat, rec, sm) !== false) return rec;
  // `false` means the table has a bound for this architecture.
  return compat.vllm.maxTagBySm[sm] ?? (compat.vllm.minTagBySm[sm] as string);
}

/** `vllm serve <model>` (positional) or the legacy api_server entrypoint (`--model <model>`). */
export function vllmPositionalModel(compat: EngineCompat, tag: string | undefined): boolean {
  const v = tag === undefined ? undefined : parseVllmTag(tag);
  const from = parseVllmTag(compat.vllm.positionalModelFromTag);
  // latest/nightly/custom tags are current builds: positional.
  if (!v || !from) return true;
  return compareVersions(v, from) >= 0;
}

/** CUDA version of the default image for a tag (for "driver too old" hints). */
export function vllmCudaForTag(compat: EngineCompat, tag: string): string | undefined {
  const v = parseVllmTag(tag);
  if (!v) return undefined;
  let cuda: string | undefined;
  for (const row of compat.vllm.cudaByTag) {
    const from = parseVllmTag(row.fromTag);
    if (from && compareVersions(v, from) >= 0) cuda = row.cuda;
  }
  return /-cu129\b/.test(tag) ? '12.9' : cuda;
}
