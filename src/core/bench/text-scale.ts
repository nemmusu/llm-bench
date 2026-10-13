/**
 * Text prompts, for servers that cannot tokenize (chat servers such as NInfer, plain OpenAI
 * endpoints): the prompt is text, and its length in tokens is what the server says it read
 * (usage.prompt_tokens). Before measuring, two short requests calibrate the text: how many characters
 * make one of this model's tokens, and how many tokens the server adds around the text (chat template,
 * instruction). Every later request refines it, so prompts land within a few tokens of the length asked.
 *
 *   tokens = overhead + characters / charsPerToken
 */
import { CHARS_PER_TOKEN } from './prompts';

export interface TextScale {
  charsPerToken: number;
  /** Tokens the server adds to any prompt (template, instruction), rounded. */
  overhead: number;
}

export interface TextSample {
  chars: number;
  tokens: number;
}

export const DEFAULT_TEXT_SCALE: TextScale = { charsPerToken: CHARS_PER_TOKEN, overhead: 0 };

/** Prompt lengths (tokens, at the default scale) of the two calibration requests. */
export const CALIBRATION_TOKENS = [256, 2048] as const;

/** A prompt is "the length asked" within max(2 %, 16 tokens). */
export function closeEnough(reported: number, wanted: number): boolean {
  return Math.abs(reported - wanted) <= Math.max(16, wanted * 0.02);
}

/**
 * The scale that explains the samples: least squares when they have at least two different lengths
 * (slope = tokens per character, intercept = overhead), else the ratio of the one length with the
 * previous overhead. Absurd fits (non-positive slope, negative overhead) keep the previous scale.
 */
export function fitTextScale(samples: readonly TextSample[], prev: TextScale = DEFAULT_TEXT_SCALE): TextScale {
  const xs = samples.map((s) => s.chars);
  if (samples.length === 0) return prev;
  if (new Set(xs).size < 2) {
    const s = samples[samples.length - 1] as TextSample;
    const text = s.tokens - prev.overhead;
    return text > 0 ? { charsPerToken: s.chars / text, overhead: prev.overhead } : prev;
  }
  const n = samples.length;
  const mx = xs.reduce((a, x) => a + x, 0) / n;
  const my = samples.reduce((a, s) => a + s.tokens, 0) / n;
  const sxx = samples.reduce((a, s) => a + (s.chars - mx) ** 2, 0);
  const sxy = samples.reduce((a, s) => a + (s.chars - mx) * (s.tokens - my), 0);
  const slope = sxy / sxx;
  const overhead = Math.round(my - slope * mx);
  return slope > 0 && overhead >= 0 ? { charsPerToken: 1 / slope, overhead } : prev;
}
