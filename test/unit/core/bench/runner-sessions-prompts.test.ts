/**
 * Long conversations (agent 4's sessions step) with the prompt variants the runner hands over:
 * text prompts (no tokenizer), a BOS token, llama.cpp without an explicit slot count.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { launchParamsSchema } from '../../../../src/contract/engines';
import { BenchRunner, type RunInput } from '../../../../src/core/bench/runner';
import { hardware } from '../store/fixtures';
import { displayCommand, events, FakeAdapter, FakeTelemetry, memoryRuns, modelTarget, SMALL_CORPUS, World, type AdapterOptions } from './fakes';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function run(adapter: AdapterOptions, params: object) {
  const world = new World();
  const cacheDir = mkdtempSync(path.join(os.tmpdir(), 'gb-sessions-prompts-'));
  dirs.push(cacheDir);
  const fake = new FakeAdapter(world, adapter);
  const runner = new BenchRunner({
    clock: world.clock,
    adapter: fake,
    telemetry: new FakeTelemetry(world, { available: false }),
    runs: memoryRuns(),
    publish: events().publish,
    fingerprint: async () => hardware(),
    displayCommand,
    appVersion: '0.1.0-test',
    cacheDir,
    corpus: async () => SMALL_CORPUS,
    ownPids: () => [],
  });
  const input: RunInput = {
    runId: 'S1',
    engineConfig: { kind: 'llamacpp-native' },
    model: modelTarget(),
    params: launchParamsSchema.parse(params),
    scenario: { profile: 'custom', seed: 3, steps: [{ kind: 'sessions', depth: 200, levels: [1], turns: 2, followupTokens: 8, outputTokens: 4 }] },
    port: 5555,
    marker: 'gpubench-s',
    allowSharedGpu: false,
  };
  return { result: await runner.run(input, new AbortController().signal), fake };
}

describe('BenchRunner: long conversations, prompt variants', () => {
  it('token prompts with the BOS first; one slot when -np is not set', async () => {
    const { result, fake } = await run({ parallel: null, client: { bos: 1 } }, {});
    expect(result.status).toBe('completed');
    expect(result.metrics.sessions).toHaveLength(1);
    const sent = fake.client.requests.filter((r) => r.promptIds !== undefined && r.promptIds.length > 1);
    expect(sent.every((r) => r.promptIds![0] === 1)).toBe(true);
  });

  it('text prompts when the endpoint cannot tokenize', async () => {
    const { result, fake } = await run({ client: { tokenizeUnsupported: true } }, { parallel: 1 });
    expect(result.status).toBe('completed');
    expect(fake.client.requests.some((r) => r.promptText !== undefined && r.promptText.length > 100)).toBe(true);
  });
});
