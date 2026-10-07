import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { AppError } from '../../contract/errors';
import type { InferenceClient } from '../inference/types';
import { readJsonFile, writeFileAtomic } from '../store/atomic';

/** Rough characters per token for endpoints that cannot tokenize (English prose ≈ 4). */
export const CHARS_PER_TOKEN = 4;
/** Tokenize the corpus in blocks of this many characters: some servers cap the request size. */
export const TOKENIZE_BLOCK_CHARS = 16 * 1024;
const CACHE_VERSION = 1;

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** The bundled public-domain corpus (resources/corpus/corpus.txt). */
export async function loadCorpus(resourcesDir: string): Promise<string> {
  const file = path.join(resourcesDir, 'corpus', 'corpus.txt');
  try {
    return await fs.readFile(file, 'utf8');
  } catch (e) {
    throw new AppError('INTERNAL', `Benchmark corpus missing: ${file}`, { cause: e });
  }
}

/**
 * Splits text into blocks of at most `maxChars`, preferring paragraph boundaries. Separators stay
 * attached, so `blocks.join('') === text`.
 */
export function splitBlocks(text: string, maxChars = TOKENIZE_BLOCK_CHARS): string[] {
  const blocks: string[] = [];
  let current = '';
  for (const para of text.split(/(?<=\n\n)/)) {
    if (current && current.length + para.length > maxChars) {
      blocks.push(current);
      current = '';
    }
    if (para.length <= maxChars) {
      current += para;
      continue;
    }
    for (let i = 0; i < para.length; i += maxChars) {
      const piece = para.slice(i, i + maxChars);
      if (piece.length === maxChars) blocks.push(piece);
      else current = piece;
    }
  }
  if (current) blocks.push(current);
  return blocks;
}

/** Leading special token the model adds (BOS), found by tokenizing a probe with and without specials. */
export async function detectBos(client: InferenceClient, signal?: AbortSignal): Promise<number | undefined> {
  const opts = (addSpecial: boolean) => ({ addSpecial, ...(signal ? { signal } : {}) });
  const withSpecial = await client.tokenize('Hello', opts(true));
  const without = await client.tokenize('Hello', opts(false));
  return withSpecial.length > without.length && withSpecial[0] !== without[0] ? withSpecial[0] : undefined;
}

export interface CorpusTokens {
  tokens: number[];
  /** BOS id to prepend to every prompt (token-id prompts are sent verbatim). */
  bos?: number;
}

const cacheSchema = z.object({
  version: z.literal(CACHE_VERSION),
  modelKey: z.string(),
  corpusSha256: z.string(),
  bos: z.number().nullable(),
  tokens: z.array(z.number()).min(1),
});

/** cacheDir/tokens/<sha256(modelKey)>.json */
export function tokenCacheFile(cacheDir: string, modelKey: string): string {
  return path.join(cacheDir, 'tokens', `${sha256(modelKey)}.json`);
}

/**
 * Corpus token ids for a model, tokenized once (block by block, without special tokens) and
 * cached on disk. The cache is invalidated when the corpus changes. A failing cache write never
 * fails the run.
 */
export async function getCorpusTokens(
  client: InferenceClient,
  modelKey: string,
  cacheDir: string,
  opts: { corpus: string; signal?: AbortSignal },
): Promise<CorpusTokens> {
  const file = tokenCacheFile(cacheDir, modelKey);
  const corpusSha256 = sha256(opts.corpus);
  const cached = cacheSchema.safeParse(await readJsonFile(file).catch(() => undefined));
  if (cached.success && cached.data.modelKey === modelKey && cached.data.corpusSha256 === corpusSha256) {
    return { tokens: cached.data.tokens, ...(cached.data.bos !== null ? { bos: cached.data.bos } : {}) };
  }
  const signalOpt = opts.signal ? { signal: opts.signal } : {};
  const bos = await detectBos(client, opts.signal);
  const tokens: number[] = [];
  for (const block of splitBlocks(opts.corpus)) {
    for (const id of await client.tokenize(block, { addSpecial: false, ...signalOpt })) tokens.push(id);
  }
  if (tokens.length === 0) {
    throw new AppError('ENDPOINT_INVALID', 'Corpus tokenization returned no tokens', { params: { reason: 'no_tokens' } });
  }
  const payload = { version: CACHE_VERSION, modelKey, corpusSha256, bos: bos ?? null, tokens };
  await writeFileAtomic(file, JSON.stringify(payload)).catch(() => undefined);
  return { tokens, ...(bos !== undefined ? { bos } : {}) };
}

/** 32-bit FNV-1a: tiny, stable across platforms and Node versions. */
function fnv1a(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

function gcd(a: number, b: number): number {
  while (b) [a, b] = [b, a % b];
  return a;
}

/**
 * Start offset of a prompt in a corpus of `size` units. Deterministic from (seed, length, salt)
 * and different for every repetition: consecutive reps are a golden-ratio stride apart, with the
 * stride made coprime with `size` so offsets never repeat before `size` repetitions. Different
 * starts mean different prefixes, so the engine's prefix cache never helps.
 */
export function promptOffset(size: number, length: number, rep: number, seed: number, salt = ''): number {
  const base = fnv1a(`${seed}:${length}:${salt}`) % size;
  let step = Math.max(1, Math.floor(size * 0.6180339887498949));
  while (gcd(step, size) !== 1) step++;
  return (base + (rep % size) * step) % size;
}

/** Passage length (tokens) used to cycle the corpus when a prompt needs more tokens than it has. */
export const PASSAGE_TOKENS = 256;
/** Same for the text fallback (characters). */
export const PASSAGE_CHARS = PASSAGE_TOKENS * CHARS_PER_TOKEN;

/**
 * Where a prompt of `length` units comes from in a corpus of `size` units, as [from, to) segments in
 * prompt order. Lap 0 is the corpus read once from `offset` (wrapping at the end, so every unit is
 * used once). A prompt longer than the corpus (very large contexts: the bundled corpus is ~100K
 * tokens) continues with further laps over the corpus cut into passages of `passage` units: each lap
 * visits the passages in a different order (an affine permutation whose step is never 1, so two
 * passages that follow each other in the book never follow each other again) and starts each passage
 * at a different point (rotation). No run longer than one passage repeats inside the prompt, and the
 * start offset (different for every request) keeps prompts from sharing a prefix across requests.
 * The limit: beyond `size` units the text is the same book in shuffled passages — attention cost
 * depends on how many tokens fill the context, not on what they say, so the timing is unaffected.
 */
export function promptSegments(size: number, length: number, offset: number, seed: number, passage: number): [number, number][] {
  const out: [number, number][] = [];
  let left = length;
  const take = (from: number, to: number) => {
    const end = Math.min(to, from + left);
    out.push([from, end]);
    left -= end - from;
  };
  take(offset, size);
  if (left > 0 && offset > 0) take(0, offset);
  const count = Math.ceil(size / passage);
  for (let lap = 1; left > 0; lap++) {
    // Step in 2…count−1 and coprime with the passage count: a permutation where no two book neighbours
    // follow each other (count − 1 is always coprime, so the search ends there at the latest).
    let step = count > 2 ? 2 + ((fnv1a(`${seed}:lap:${lap}`) + lap) % (count - 2)) : 1;
    while (gcd(step, count) !== 1) step++;
    const shift = fnv1a(`${seed}:shift:${lap}`) % count;
    for (let j = 0; j < count && left > 0; j++) {
      const p = (shift + j * step) % count;
      const from = p * passage;
      const to = Math.min(size, from + passage);
      const rot = (lap * 61) % (to - from);
      take(from + rot, to);
      if (left > 0 && rot > 0) take(from, from + rot);
    }
  }
  return out;
}

/**
 * Exact-length prompt as token ids: [BOS] + the corpus from a per-request offset, cycling through
 * shuffled passages when the prompt is longer than the corpus (see promptSegments).
 */
export function buildPrompt(
  tokens: readonly number[],
  length: number,
  rep: number,
  opts: { seed: number; bos?: number; salt?: string },
): number[] {
  if (length <= 0) return [];
  if (tokens.length === 0) throw new AppError('INTERNAL', 'Empty corpus');
  const out = opts.bos !== undefined ? [opts.bos] : [];
  const off = promptOffset(tokens.length, length, rep, opts.seed, opts.salt);
  for (const [from, to] of promptSegments(tokens.length, length - out.length, off, opts.seed + rep, PASSAGE_TOKENS)) {
    for (let i = from; i < to; i++) out.push(tokens[i] as number);
  }
  return out;
}

/**
 * Text fallback for endpoints without /tokenize: ~CHARS_PER_TOKEN chars per wanted token, so the
 * real token count is approximate (the run is flagged tokens_approximate).
 */
export function buildTextPrompt(corpus: string, length: number, rep: number, opts: { seed: number; salt?: string }): string {
  if (length <= 0) return '';
  if (corpus.length === 0) throw new AppError('INTERNAL', 'Empty corpus');
  const chars = length * CHARS_PER_TOKEN;
  const off = promptOffset(corpus.length, length, rep, opts.seed, opts.salt);
  return promptSegments(corpus.length, chars, off, opts.seed + rep, PASSAGE_CHARS)
    .map(([from, to]) => corpus.slice(from, to))
    .join('');
}
