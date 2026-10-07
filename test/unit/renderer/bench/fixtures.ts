/** Realistic runs for the benchmark-flow tests (the same seeds the E2E journeys and mockups use). */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { runResultSchema, type RunResult, type RunSummary } from '../../../../src/contract/results';
import { summaryOf } from '../../../../src/core/store/runs-repo';

const DIR = path.resolve(import.meta.dirname, '../../../fixtures/runs');

export const HOST = 'WORKSTATION';
/** This PC's id as /api/system reports it in the fake world (world.ts SYSTEM.hostId). */
export const HOST_ID = 'host-1';

export const IDS = {
  full: '01K6Y7Q2ZC4M8N3B5V9R1T0XWE',
  gemma: '01K6WQ8D3N7B2X5C9V4M6K1JHT',
  moe: '01K6WJ2F6R9T3Y8U1I4O7P5ASD',
  vllm: '01K6TZ5G1H4J7K2L8Z3X6C9VBN',
  quick: '01K6TX9Q2W5E8R1T4Y7U3I6OPA',
  gptoss: '01K6QH3B6N9M2Q5W8E1R4T7YUI',
  other: '01K6NE7R4T1Y8U5I2O9P6A3SDF',
  failed: '01K6NA2S5D8F1G4H7J3K6L9ZXC',
  cancelled: '01K6KZ8V1B4N7M2Q5W9E3R6TYU',
} as const;

let cache: RunResult[] | undefined;

export function seededRuns(): RunResult[] {
  cache ??= readdirSync(DIR)
    .filter((f) => f.endsWith('.json'))
    // Parsed like the core reads them (runs-repo): defaults of newer fields are filled in.
    .map((f) => runResultSchema.parse(JSON.parse(readFileSync(path.join(DIR, f), 'utf8').replaceAll('__THIS_HOST_ID__', HOST_ID).replaceAll('__THIS_PC__', HOST))));
  return structuredClone(cache);
}

export function seeded(id: string): RunResult {
  const run = seededRuns().find((r) => r.id === id);
  if (!run) throw new Error(`no seed ${id}`);
  return run;
}

export function summaries(runs: RunResult[] = seededRuns()): RunSummary[] {
  return runs.map((r) => summaryOf(r, `${r.id}.json`)).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}
