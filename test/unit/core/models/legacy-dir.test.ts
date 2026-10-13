import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultSettings, type Settings } from '../../../../src/contract/settings';
import { adoptLegacyModelsDir } from '../../../../src/core/models/legacy-dir';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A pretend home folder (never the real one): ~/GPU Bench/models and ~/LLM Bench/models as asked. */
function home(o: { legacy?: boolean | 'file'; current?: boolean; modelsDir?: string } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'llmbench-home-'));
  dirs.push(dir);
  const legacy = path.join(dir, 'GPU Bench', 'models');
  const current = path.join(dir, 'LLM Bench', 'models');
  if (o.legacy === 'file') {
    mkdirSync(path.dirname(legacy), { recursive: true });
    writeFileSync(legacy, '');
  } else if (o.legacy) mkdirSync(legacy, { recursive: true });
  if (o.current) mkdirSync(current, { recursive: true });
  let settings: Settings = { ...defaultSettings(), modelsDir: o.modelsDir ?? '' };
  const updates: Partial<Settings>[] = [];
  const logged: unknown[] = [];
  return {
    legacy,
    current,
    updates,
    logged,
    settings: () => settings,
    opts: (paths: { legacyModelsDir?: string } = { legacyModelsDir: legacy }) => ({
      settings: {
        get: async () => settings,
        update: async (p: Partial<Settings>) => {
          updates.push(p);
          settings = { ...settings, ...p };
          return settings;
        },
      },
      paths: { modelsDir: current, ...paths },
      log: { info: (msg: string, data?: Record<string, unknown>) => void logged.push([msg, data]) },
    }),
  };
}

describe('GPU Bench’s default models folder stays the models folder (models are never moved)', () => {
  it('the default kept, the old folder there and no new one: the old one is written in the settings', async () => {
    const h = home({ legacy: true });
    expect(await adoptLegacyModelsDir(h.opts())).toBe(h.legacy);
    expect(h.updates).toEqual([{ modelsDir: h.legacy }]);
    expect(h.logged).toEqual([['models folder of GPU Bench kept', { modelsDir: h.legacy }]]);
    // Once written, it is the user's folder like any other: nothing more to do.
    expect(await adoptLegacyModelsDir(h.opts())).toBeUndefined();
    expect(h.updates).toHaveLength(1);
  });

  it('left alone: a folder the user chose, no old folder (or a file by that name), models already in the new one, tests', async () => {
    const chosen = home({ legacy: true, modelsDir: 'D:\\models' });
    expect(await adoptLegacyModelsDir(chosen.opts())).toBeUndefined();
    const fresh = home();
    expect(await adoptLegacyModelsDir(fresh.opts())).toBeUndefined();
    const file = home({ legacy: 'file' });
    expect(await adoptLegacyModelsDir(file.opts())).toBeUndefined();
    const both = home({ legacy: true, current: true });
    expect(await adoptLegacyModelsDir(both.opts())).toBeUndefined();
    // GPUBENCH_MODELS_DIR (tests): no old folder known.
    const tests = home({ legacy: true });
    expect(await adoptLegacyModelsDir(tests.opts({}))).toBeUndefined();
    for (const h of [chosen, fresh, file, both, tests]) expect(h.updates).toEqual([]);
  });
});
