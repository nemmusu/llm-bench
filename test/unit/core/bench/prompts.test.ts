import fc from 'fast-check';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AppError } from '../../../../src/contract/errors';
import {
  buildPrompt,
  buildTextPrompt,
  CHARS_PER_TOKEN,
  detectBos,
  getCorpusTokens,
  loadCorpus,
  promptOffset,
  sha256,
  splitBlocks,
  tokenCacheFile,
} from '../../../../src/core/bench/prompts';
import type { InferenceClient } from '../../../../src/core/inference/types';

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(path.join(os.tmpdir(), 'gb-prompts-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Tokenizer stand-in: one token per character (code point), optional BOS. */
function charClient(opts: { bos?: number; calls?: { text: string; addSpecial: boolean }[]; empty?: boolean } = {}): InferenceClient {
  return {
    flavor: 'llamacpp',
    baseUrl: 'http://fake',
    ready: async () => true,
    tokenize: async (text, o = {}) => {
      opts.calls?.push({ text, addSpecial: o.addSpecial ?? false });
      if (opts.empty) return [];
      const ids = Array.from(text, (ch) => ch.codePointAt(0) as number);
      return o.addSpecial && opts.bos !== undefined ? [opts.bos, ...ids] : ids;
    },
    generate: async function* () {},
    requestBody: () => ({}),
    models: async () => [],
  };
}

describe('loadCorpus', () => {
  it('reads the bundled corpus (public domain, a few hundred KB)', async () => {
    const text = await loadCorpus(path.resolve('resources'));
    expect(text.length).toBeGreaterThan(300_000);
    expect(text.length).toBeLessThan(600_000);
    expect(text).not.toMatch(/project gutenberg/i);
  });
  it('fails with INTERNAL when missing', async () => {
    await expect(loadCorpus(tmp())).rejects.toMatchObject({ code: 'INTERNAL' });
  });
});

describe('splitBlocks', () => {
  it('keeps paragraphs together and reassembles exactly', () => {
    const text = 'aaaa\n\nbbbb\n\ncccccccccccccccccccc\n\nd';
    const blocks = splitBlocks(text, 8);
    expect(blocks.join('')).toBe(text);
    expect(blocks.every((b) => b.length <= 8)).toBe(true);
    expect(blocks[0]).toBe('aaaa\n\n');
    expect(splitBlocks('', 8)).toEqual([]);
    expect(splitBlocks('x'.repeat(16), 8)).toEqual(['x'.repeat(8), 'x'.repeat(8)]);
  });
  it('property: blocks are bounded and lossless', () => {
    fc.assert(
      fc.property(fc.string({ unit: fc.constantFrom('a', 'b', ' ', '\n') }), fc.integer({ min: 1, max: 30 }), (text, max) => {
        const blocks = splitBlocks(text, max);
        expect(blocks.join('')).toBe(text);
        expect(blocks.every((b) => b.length > 0 && b.length <= max)).toBe(true);
      }),
    );
  });
});

describe('detectBos', () => {
  it('finds a leading special token', async () => {
    expect(await detectBos(charClient({ bos: 1 }))).toBe(1);
    expect(await detectBos(charClient(), new AbortController().signal)).toBeUndefined();
  });
});

describe('getCorpusTokens', () => {
  it('tokenizes block by block without specials, caches by model key and corpus hash', async () => {
    const cache = tmp();
    const calls: { text: string; addSpecial: boolean }[] = [];
    const corpus = 'Hello world.\n\n'.repeat(3000);
    const a = await getCorpusTokens(charClient({ bos: 1, calls }), 'llamacpp:abc', cache, { corpus, signal: new AbortController().signal });
    expect(a.bos).toBe(1);
    expect(a.tokens.length).toBe(corpus.length);
    const blockCalls = calls.filter((c) => !c.addSpecial && c.text !== 'Hello');
    expect(blockCalls.length).toBeGreaterThan(1);
    expect(blockCalls.every((c) => c.text.length <= 16 * 1024)).toBe(true);
    const file = tokenCacheFile(cache, 'llamacpp:abc');
    expect(path.basename(file)).toBe(`${sha256('llamacpp:abc')}.json`);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ version: 1, modelKey: 'llamacpp:abc', bos: 1 });

    calls.length = 0;
    const b = await getCorpusTokens(charClient({ calls }), 'llamacpp:abc', cache, { corpus });
    expect(calls).toEqual([]);
    expect(b).toEqual(a);

    // A changed corpus invalidates the cache.
    const c = await getCorpusTokens(charClient({ calls }), 'llamacpp:abc', cache, { corpus: 'Other text' });
    expect(c.tokens.length).toBe(10);
    expect(c).not.toHaveProperty('bos');
    const d = await getCorpusTokens(charClient({ calls: [] }), 'llamacpp:abc', cache, { corpus: 'Other text' });
    expect(d).toEqual({ tokens: c.tokens });
  });

  it('ignores a corrupt cache and survives an unwritable cache dir', async () => {
    const cache = tmp();
    const file = tokenCacheFile(cache, 'k');
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, '{not json');
    expect((await getCorpusTokens(charClient(), 'k', cache, { corpus: 'abc' })).tokens).toEqual([97, 98, 99]);
    // cacheDir is a file: mkdir fails, the result is still returned.
    const blocker = path.join(tmp(), 'file');
    writeFileSync(blocker, 'x');
    expect((await getCorpusTokens(charClient(), 'k', blocker, { corpus: 'abc' })).tokens).toEqual([97, 98, 99]);
  });

  it('fails when the endpoint returns no tokens', async () => {
    await expect(getCorpusTokens(charClient({ empty: true }), 'k', tmp(), { corpus: 'abc' })).rejects.toBeInstanceOf(AppError);
  });
});

describe('promptOffset / buildPrompt / buildTextPrompt', () => {
  const tokens = Array.from({ length: 1000 }, (_, i) => i + 10);

  it('builds exact-length prompts with BOS first', () => {
    const p = buildPrompt(tokens, 512, 0, { seed: 42, bos: 1 });
    expect(p.length).toBe(512);
    expect(p[0]).toBe(1);
    expect(buildPrompt(tokens, 512, 0, { seed: 42 }).length).toBe(512);
    expect(buildPrompt(tokens, 0, 0, { seed: 42 })).toEqual([]);
    expect(buildPrompt(tokens, 1, 0, { seed: 1, bos: 7 })).toEqual([7]);
  });

  it('wraps around when the prompt is longer than the corpus', () => {
    const p = buildPrompt([1, 2, 3], 7, 0, { seed: 0 });
    expect(p.length).toBe(7);
    expect(new Set(p)).toEqual(new Set([1, 2, 3]));
  });

  it('is deterministic and different per repetition and length', () => {
    expect(buildPrompt(tokens, 64, 3, { seed: 42 })).toEqual(buildPrompt(tokens, 64, 3, { seed: 42 }));
    const firsts = new Set(Array.from({ length: 100 }, (_, rep) => promptOffset(tokens.length, 512, rep, 42)));
    expect(firsts.size).toBe(100);
    expect(promptOffset(1000, 512, 0, 42)).not.toBe(promptOffset(1000, 4096, 0, 42));
    expect(promptOffset(1000, 512, 0, 42, 'a')).not.toBe(promptOffset(1000, 512, 0, 42, 'b'));
    expect(promptOffset(1, 5, 9, 1)).toBe(0);
  });

  it('property: offsets never repeat before `size` repetitions', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 400 }), fc.integer({ min: 1, max: 50000 }), fc.integer(), (size, length, seed) => {
        const seen = new Set<number>();
        for (let rep = 0; rep < size; rep++) seen.add(promptOffset(size, length, rep, seed));
        expect(seen.size).toBe(size);
      }),
      { numRuns: 60 },
    );
  });

  it('rejects an empty corpus', () => {
    expect(() => buildPrompt([], 4, 0, { seed: 1 })).toThrow(AppError);
    expect(() => buildTextPrompt('', 4, 0, { seed: 1 })).toThrow(AppError);
  });

  it('text fallback: ~4 chars per token, wrapping, deterministic', () => {
    const t = buildTextPrompt('abcdefghij', 5, 2, { seed: 9, salt: 'x' });
    expect(t.length).toBe(5 * CHARS_PER_TOKEN);
    expect(buildTextPrompt('abcdefghij', 5, 2, { seed: 9, salt: 'x' })).toBe(t);
    expect(buildTextPrompt('abc', 0, 0, { seed: 1 })).toBe('');
  });
});
