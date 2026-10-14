/**
 * A real "Trova le impostazioni migliori" with NInfer (test/fixtures/runs/tune: names and paths
 * removed, statistics trimmed): rk8v4 reaches 256K but the time ran out after 64K, so no combination
 * was measured with its context full. Its twin below did fill rk8v4's 256K: a text prompt refused as
 * too long and sent again shorter (255 000 tokens), still the context full.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { RunResult, RunSummary } from '../../../../src/contract/results';
import { parseRun, summaryOf } from '../../../../src/core/store/runs-repo';
import { point } from '../tune/tune-fixtures';
import { HOST, HOST_ID } from './fixtures';

const FILE = path.resolve(import.meta.dirname, '../../../fixtures/runs/tune/2026-10-14_11-54-04_ninfer-tune-256k.json');

export const NINFER_ID = '01M4X46BTJW9EH2YHE32Q7N9ZM';
export const K = 1024;
/** rk8v4, the recommended combination (index 2), and nvfp4 (3): both start with a 256K context. */
export const RK8 = 2;
export const NVFP4 = 3;

/** The search as it was saved (this PC, this card). */
export function ninferTune(): RunResult {
  return parseRun(JSON.parse(readFileSync(FILE, 'utf8').replaceAll('__THIS_HOST_ID__', HOST_ID).replaceAll('__THIS_PC__', HOST)))!;
}

/** The same search with rk8v4 measured with its 256K full (generation 80,1 tok/s, reading 2.400 tok/s). */
export function ninferTuneFull(id = '01M4X46BTJW9EH2YHE32Q7FULL'): RunResult {
  const run = ninferTune();
  run.id = id;
  run.tuning!.combinations[RK8]!.sweep.push(point(255_000, 80.1, 2400, 106_250));
  return run;
}

/**
 * The Results list row of a one-user search (the core's summary): every speed from the recommended
 * combination's point with the context full, at its context; else all from its deepest point.
 */
export function tuneSummary(run: RunResult, full: boolean): RunSummary {
  const base = summaryOf(run, `${run.id}.json`);
  return full
    ? { ...base, decodeTps: 80.1, prefillTps: 2400, ttftMs: 106_250, decodeTokens: 256 * K, prefillTokens: 256 * K, speedBasis: 'depth' }
    : { ...base, decodeTps: 82.99, prefillTps: 3150, ttftMs: 20_821, decodeTokens: 65_326, prefillTokens: 65_326, speedBasis: 'depth' };
}
