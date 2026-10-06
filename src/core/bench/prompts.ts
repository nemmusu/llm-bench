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

/**
 * Exact-length prompt as token ids: [BOS] + corpus[offset … offset + length − 1), wrapping around
 * the corpus when needed.
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
  for (let i = 0; out.length < length; i++) out.push(tokens[(off + i) % tokens.length] as number);
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
  let out = corpus.slice(off, off + chars);
  while (out.length < chars) out += corpus.slice(0, chars - out.length);
  return out;
}
