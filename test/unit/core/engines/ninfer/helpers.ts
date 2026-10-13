/** Shared pieces of the NInfer tests: fakes, a library model, a real process runner with the fake wsl. */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LocalModel } from '../../../../../src/contract/models';
import type { Clock, ProcessRunner } from '../../../../../src/core/deps';
import type { ClientFactory } from '../../../../../src/core/engines/instance';
import type { ModelTarget } from '../../../../../src/core/engines/types';
import { createInferenceClient } from '../../../../../src/core/inference/client';
import { systemClock } from '../../../../../src/core/node-deps';
import { createProcessRunner } from '../../../../../src/core/process/runner';

export const FAKE_WSL = fileURLToPath(new URL('../../../../fakes/fake-wsl/fake-wsl.mjs', import.meta.url));
export const FAKE_NINFER = fileURLToPath(new URL('../../../../fakes/fake-engine/ninfer-cli.mjs', import.meta.url));
export const NINFER_FIXTURES = fileURLToPath(new URL('../../../../fixtures/ninfer/', import.meta.url));
export const WSL_ARGV = [process.execPath, FAKE_WSL];

/** The manifest of Qwen3.8-27B NVFP4 as on Hugging Face (artifact object only). */
export const MANIFEST = {
  schema: 'ninfer.artifact-manifest',
  schema_version: 2,
  artifact: { filename: 'qwen3_8_27b_nvfp4.ninfer', bytes: 4096, sha256: 'ab'.repeat(32), container_version: 3, architecture: 'Qwen3_5ForCausalLM', name: 'qwen3.8-27b', components: ['text', 'vision', 'mtp', 'dflash2'] },
};

/** A library .ninfer model in `dir` (artifact + manifest), as the scanner lists it. */
export function ninferModel(dir: string, o: { manifest?: boolean; bytes?: number } = {}): ModelTarget & { local: LocalModel } {
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'qwen3_8_27b_nvfp4.ninfer');
  writeFileSync(file, Buffer.alloc(o.bytes ?? 4096));
  const paths = [file];
  if (o.manifest !== false) {
    const manifest = path.join(dir, 'Qwen3.8-27B-nvfp4-NInfer.artifact-manifest.json');
    writeFileSync(manifest, JSON.stringify(MANIFEST));
    paths.push(manifest);
  }
  const identity: LocalModel['identity'] = {
    displayName: 'qwen3_8_27b_nvfp4',
    format: 'ninfer',
    source: 'local',
    file: 'qwen3_8_27b_nvfp4.ninfer',
    files: ['qwen3_8_27b_nvfp4.ninfer'],
    sizeBytes: o.bytes ?? 4096,
    weakKey: 'ninfer/qwen3_8_27b_nvfp4',
    facts: { name: 'qwen3.8-27b', architecture: 'Qwen3_5ForCausalLM' },
  };
  const local: LocalModel = { id: 'n1', identity, paths, auxiliary: [], dir, origin: 'library', modifiedAt: '2026-10-01T00:00:00.000Z' };
  return { identity, local };
}

/** Clients over the real fetch, as the composition root builds them. */
export const realClients: ClientFactory = (flavor, baseUrl, o) => createInferenceClient(flavor, baseUrl, { fetch: globalThis.fetch, clock: systemClock }, o ?? {});

/** A real process runner whose children see the fake wsl's state and a fast fake NInfer. */
export function realProc(stateDir: string, extra: Record<string, string> = {}, clock: Clock = systemClock): ProcessRunner {
  return createProcessRunner({
    clock,
    platform: process.platform,
    baseEnv: {
      ...process.env,
      FAKE_WSL_STATE: stateDir,
      FAKE_ENGINE_PROFILE: JSON.stringify({ loadMsWarm: 120, prefillTps: 40_000, decodeTps: 2000, tokensPerChunk: 2 }),
      ...extra,
    },
  });
}
