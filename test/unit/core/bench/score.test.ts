import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ModelIdentity } from '../../../../src/contract/models';
import type { LatencyPoint, Stat } from '../../../../src/contract/results';
import {
  computeScore,
  isReferenceModel,
  loadScoreReference,
  relativeDelta,
  scoreInputs,
  scoreRun,
  type ScoreReference,
} from '../../../../src/core/bench/score';
import { summarize } from '../../../../src/core/bench/stats';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const ref: ScoreReference = {
  version: 3,
  provisional: true,
  referenceModel: { repo: 'Qwen/Qwen3-4B-GGUF', file: 'Qwen3-4B-Q4_K_M.gguf' },
  D_ref: 250,
  P_ref: 12000,
  L_ref: 1.5,
};

const stat = (v: number): Stat => summarize([v]);
function point(promptTokens: number, decode: number, prefill: number): LatencyPoint {
  return {
    promptTokens,
    outputTokens: 256,
    ttftMs: stat(10),
    prefillTps: stat(prefill),
    decodeTps: stat(decode),
    itlP50Ms: 4,
    itlP95Ms: 5,
    itlPerChunk: false,
    totalMs: stat(100),
  };
}

const model = (over: Partial<ModelIdentity> = {}): ModelIdentity => ({
  displayName: 'Qwen3 4B',
  format: 'gguf',
  source: 'local',
  files: [],
  weakKey: 'k',
  file: 'Qwen3-4B-Q4_K_M.gguf',
  ...over,
});

describe('loadScoreReference', () => {
  it('reads the bundled provisional reference', async () => {
    const r = await loadScoreReference(path.resolve('resources'));
    expect(r).toMatchObject({ version: 1, provisional: true, D_ref: 250, P_ref: 12000, L_ref: 1.5 });
  });
  it('undefined when missing or invalid', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'gb-score-'));
    dirs.push(dir);
    expect(await loadScoreReference(dir)).toBeUndefined();
    writeFileSync(path.join(dir, 'score-reference.json'), JSON.stringify({ version: 1 }));
    expect(await loadScoreReference(dir)).toBeUndefined();
  });
});

describe('computeScore', () => {
  it('is 1000 on the reference and follows the exponents', () => {
    expect(computeScore({ D: 250, P: 12000, L: 1.5 }, ref)).toBe(1000);
    expect(computeScore({ D: 1000, P: 12000, L: 1.5 }, ref)).toBe(2000);
    expect(computeScore({ D: 250, P: 12000, L: 1.5 * 32 }, ref)).toBe(500);
  });
});

describe('isReferenceModel', () => {
  it('prefers sha256, else file name (+ repo when known)', () => {
    const withSha = { ...ref, referenceModel: { ...ref.referenceModel, sha256: 'ABC' } };
    expect(isReferenceModel(model({ sha256: 'abc', file: 'other.gguf' }), withSha)).toBe(true);
    expect(isReferenceModel(model({ sha256: 'def' }), withSha)).toBe(false);
    expect(isReferenceModel(model(), withSha)).toBe(true);
    expect(isReferenceModel(model({ file: 'C:/models/qwen3-4b-q4_k_m.GGUF' }), ref)).toBe(true);
    expect(isReferenceModel(model({ repo: 'qwen/qwen3-4b-gguf' }), ref)).toBe(true);
    expect(isReferenceModel(model({ repo: 'someone/else' }), ref)).toBe(false);
    expect(isReferenceModel(model({ file: undefined }), ref)).toBe(false);
    expect(isReferenceModel(model({ file: 'x.gguf' }), ref)).toBe(false);
  });
});

describe('scoreInputs / scoreRun', () => {
  const metrics = { latency: [point(512, 250, 6000), point(4096, 200, 12000)], load: { warmMs: stat(1500), phases: [] } };
  it('D at 512, P at 4096 (or the largest), L warm seconds', () => {
    expect(scoreInputs(metrics)).toEqual({ D: 250, P: 12000, L: 1.5 });
    expect(scoreInputs({ latency: [point(512, 250, 6000), point(2048, 1, 9000)], load: metrics.load })).toEqual({ D: 250, P: 9000, L: 1.5 });
    expect(scoreInputs({ latency: [point(4096, 1, 1)], load: metrics.load })).toBeUndefined();
    expect(scoreInputs({ latency: [point(512, 250, 0)], load: metrics.load })).toBeUndefined();
    expect(scoreInputs({ latency: [point(512, 250, 6000)], load: { phases: [] } })).toBeUndefined();
    expect(scoreInputs({ latency: [], load: metrics.load })).toBeUndefined();
  });
  it('only the standard profile on the reference model is scored', () => {
    expect(scoreRun({ profile: 'standard', model: model(), metrics }, ref)).toEqual({ value: 1000, referenceVersion: 3 });
    expect(scoreRun({ profile: 'quick', model: model(), metrics }, ref)).toBeUndefined();
    expect(scoreRun({ profile: 'standard', model: model({ file: 'x.gguf' }), metrics }, ref)).toBeUndefined();
    expect(scoreRun({ profile: 'standard', model: model(), metrics }, undefined)).toBeUndefined();
    expect(scoreRun({ profile: 'standard', model: model(), metrics: { latency: [], load: metrics.load } }, ref)).toBeUndefined();
  });
});

describe('relativeDelta', () => {
  it('(a − b) / b', () => {
    expect(relativeDelta(123, 100)).toBeCloseTo(0.23);
    expect(relativeDelta(50, 100)).toBe(-0.5);
    expect(relativeDelta(1, 0)).toBeUndefined();
    expect(relativeDelta(Number.NaN, 1)).toBeUndefined();
    expect(relativeDelta(1, Infinity)).toBeUndefined();
  });
});
