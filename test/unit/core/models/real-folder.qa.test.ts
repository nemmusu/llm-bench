/**
 * QA against a real model folder, read-only (nothing is written there: the facts cache goes to a temp
 * folder). Skipped unless GPUBENCH_QA_MODELS names one or more folders (";"-separated):
 *   GPUBENCH_QA_MODELS="E:\home\me\GPU Bench\models;E:\home\me\models" npx vitest run test/unit/core/models/real-folder.qa.test.ts
 * Prints what the scanner found and checks that no model file is lost: every GGUF, safetensors and
 * .ninfer file is a model, an auxiliary of one, or part of a model listed as incomplete.
 */
import { mkdtempSync, readdirSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Logger } from '../../../../src/core/deps';
import { ModelScanner } from '../../../../src/core/models/scanner';

const ROOTS = (process.env.GPUBENCH_QA_MODELS ?? '').split(';').filter(Boolean);

/** Every model file under `dir` (what the scanner must account for). */
function modelFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name.startsWith('.')) continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) modelFiles(full, out);
    else if (/\.(gguf|safetensors|ninfer)$/i.test(name)) out.push(full);
  }
  return out;
}

describe.skipIf(ROOTS.length === 0)('QA: a real model folder', () => {
  it('accounts for every model file', async () => {
    const quiet = () => undefined;
    const log: Logger = { debug: quiet, info: quiet, warn: (m, d) => console.log('WARN', m, d ?? ''), error: (m, d) => console.log('ERROR', m, d ?? '') };
    const scanner = new ModelScanner({
      platform: process.platform === 'win32' ? 'win32' : 'linux',
      home: os.homedir(),
      env: {},
      defaultModelsDir: mkdtempSync(path.join(os.tmpdir(), 'gb-qa-lib-')),
      cacheDir: mkdtempSync(path.join(os.tmpdir(), 'gb-qa-cache-')),
      log,
      settings: async () => ({ modelsDir: '', extraModelDirs: ROOTS, scanKnownLocations: false }),
    });
    const models = await scanner.scan();
    for (const m of models) {
      const id = m.identity;
      console.log(
        'MODEL',
        JSON.stringify({ name: id.displayName, format: id.format, repo: id.repo, quant: id.quant, sha: id.sha256 ? 'yes' : 'no', aux: m.auxiliary.map((a) => `${a.kind}:${path.basename(a.path)}`), incomplete: m.incomplete }),
      );
    }
    const known = new Set(models.flatMap((m) => m.paths).map((p) => path.resolve(p).toLowerCase()));
    const lost = ROOTS.flatMap((r) => modelFiles(r)).filter((f) => !known.has(path.resolve(f).toLowerCase()));
    expect(lost).toEqual([]);
  }, 300_000);
});
