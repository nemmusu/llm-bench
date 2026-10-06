/**
 * Synthetic GGUF / safetensors fixtures, generated on the fly by the tests (no big binaries in
 * git). Same writer the fake hub uses, so local and remote parsing are tested on identical bytes.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { buildGguf, buildSafetensors, type GgufSpec, type SafetensorsSpec } from '../../fakes/fake-hub/model-files.mjs';

export { buildGguf, buildSafetensors, gv, GGUF_TYPE, llamaLikeGguf, seededBytes } from '../../fakes/fake-hub/model-files.mjs';
export type { GgufSpec, GgufTensorSpec, GgufValue, LlamaLikeOptions, SafetensorsSpec } from '../../fakes/fake-hub/model-files.mjs';

export function writeGguf(file: string, spec: GgufSpec = {}): string {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, buildGguf(spec));
  return file;
}

export function writeSafetensors(file: string, spec: SafetensorsSpec = {}): string {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, buildSafetensors(spec));
  return file;
}
