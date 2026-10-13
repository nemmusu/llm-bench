import { promises as fs } from 'node:fs';
import type { Settings } from '../../contract/settings';
import type { CorePaths, Logger } from '../deps';

export interface LegacyModelsDirOptions {
  settings: { get(): Promise<Pick<Settings, 'modelsDir'>>; update(patch: Partial<Settings>): Promise<unknown> };
  paths: Pick<CorePaths, 'modelsDir' | 'legacyModelsDir'>;
  log: Pick<Logger, 'info'>;
}

/**
 * Models are never moved by the rename GPU Bench → LLM Bench (0.4.0). The default models folder was
 * ~/GPU Bench/models: while the user keeps the default (settings.modelsDir empty), that folder exists
 * and the new default (~/LLM Bench/models) does not, the old one becomes the models folder, written
 * in the settings, so downloads keep going where the models already are. Returns it when adopted.
 */
export async function adoptLegacyModelsDir(o: LegacyModelsDirOptions): Promise<string | undefined> {
  const legacy = o.paths.legacyModelsDir;
  if (legacy === undefined || (await o.settings.get()).modelsDir) return undefined;
  const isDir = (p: string) =>
    fs.stat(p).then(
      (s) => s.isDirectory(),
      () => false,
    );
  if (!(await isDir(legacy)) || (await isDir(o.paths.modelsDir))) return undefined;
  await o.settings.update({ modelsDir: legacy });
  o.log.info('models folder of GPU Bench kept', { modelsDir: legacy });
  return legacy;
}
