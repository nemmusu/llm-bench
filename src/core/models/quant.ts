import { GGMLFileQuantizationType, parseGGUFQuantLabel } from '@huggingface/gguf';

/**
 * Quant label from a file name ("gemma-4-31B-it-UD-Q4_K_XL.gguf" → "UD-Q4_K_XL"). The Unsloth
 * "UD-" prefix is kept because a repo can ship both "UD-Q4_K_M" and "Q4_K_M". Both the scanner
 * and the hub client use this, so weak keys of a download and of its hub listing agree.
 * Beyond llama.cpp's own types: PrismML's ternary PQ2_0 / PTQ1_0 (only its fork reads them; read
 * before the generic parser, which would call PQ2_0 "Q2_0") and community labels that start like a
 * quant ("…-Q4LynnStyle-MTP.gguf" → "Q4LynnStyle").
 */
export function quantFromFilename(name: string): string | undefined {
  const prism = /(?:^|[-_.(])(PT?Q\d+_\d+)(?=[-_.)]|$)/i.exec(name);
  if (prism) return (prism[1] as string).toUpperCase();
  const known = parseGGUFQuantLabel(name);
  if (known) return known;
  return /(?:^|[-_.(])((?:UD-)?I?Q\d[A-Za-z0-9_]*)(?=[-_.)]|$)/i.exec(name.replace(/\.gguf$/i, ''))?.[1];
}

/** Name of a GGUF `general.file_type` value (llama_ftype), e.g. 15 → "Q4_K_M". */
export function ftypeName(ftype: number | undefined): string | undefined {
  if (ftype === undefined) return undefined;
  const name = (GGMLFileQuantizationType as unknown as Record<number, string | undefined>)[ftype];
  return name;
}

/** Strips decorations that do not change the storage format ("UD-" prefix, case). */
export function normalizeQuant(quant: string): string {
  return quant.toUpperCase().replace(/^UD-/, '');
}

/**
 * Bytes per parameter by quantization, from llmfit (github.com/AlexsJones/llmfit, MIT).
 * Used only when the real file size is unknown. Unlisted labels fall back to their bit family.
 */
const BYTES_PER_PARAM: Record<string, number> = {
  F32: 4.0,
  F16: 2.0,
  BF16: 2.0,
  Q8_0: 1.05,
  Q6_K: 0.8,
  Q5_K_M: 0.68,
  Q4_K_M: 0.58,
  Q4_0: 0.58,
  Q3_K_M: 0.48,
  Q2_K: 0.37,
};

const FAMILIES: [RegExp, number][] = [
  [/^(FP32|F32)/, 4.0],
  [/^(FP16|F16|BF16)/, 2.0],
  [/^(FP8|INT8|W8A8|Q8)/, 1.05],
  [/^Q6/, 0.8],
  [/^Q5/, 0.68],
  [/^(Q4|IQ4|MXFP4|NVFP4|AWQ|GPTQ|BNB|INT4)/, 0.58],
  [/^(Q3|IQ3)/, 0.48],
  [/^(Q2|IQ2)/, 0.37],
  [/^(IQ1|TQ1|TQ2|Q1)/, 0.25],
];

export const DEFAULT_BYTES_PER_PARAM = 0.58;

export function bytesPerParam(quant: string | undefined): number {
  if (!quant) return DEFAULT_BYTES_PER_PARAM;
  const q = normalizeQuant(quant);
  const exact = BYTES_PER_PARAM[q];
  if (exact !== undefined) return exact;
  for (const [re, bytes] of FAMILIES) if (re.test(q)) return bytes;
  return DEFAULT_BYTES_PER_PARAM;
}

/** "31B" → 31, "470M" → 0.47, "8x7B" → 56, "30B-A3B" → 30 (total, not active). */
export function paramsFromLabel(label: string | undefined): number | undefined {
  if (!label) return undefined;
  // No "K": "4k" in a repo name is a context length, not a parameter count.
  const scale: Record<string, number> = { M: 1e-3, B: 1, T: 1e3 };
  const moe = /(\d+(?:\.\d+)?)\s*x\s*(\d+(?:\.\d+)?)\s*([MBT])(?![a-z])/i.exec(label);
  if (moe) return round3(Number(moe[1]) * Number(moe[2]) * (scale[moe[3]!.toUpperCase()] as number));
  const m = /(\d+(?:\.\d+)?)\s*([MBT])(?![a-z])/i.exec(label);
  if (!m) return undefined;
  return round3(Number(m[1]) * (scale[m[2]!.toUpperCase()] as number));
}

export function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
