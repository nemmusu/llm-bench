import path from 'node:path';
import { defaultSettings, settingsSchema, type Settings } from '../../contract/settings';
import { readJsonFile, writeFileAtomic } from './atomic';

/** settings.json in the data dir. Unknown/invalid content falls back to defaults (never crashes the app). */
export class SettingsRepo {
  private cache: Settings | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  readonly file: string;

  constructor(dataDir: string) {
    this.file = path.join(dataDir, 'settings.json');
  }

  async get(): Promise<Settings> {
    if (this.cache) return this.cache;
    let raw: unknown = {};
    try {
      raw = await readJsonFile(this.file);
    } catch {
      raw = {};
    }
    const parsed = settingsSchema.safeParse(raw);
    this.cache = parsed.success ? parsed.data : defaultSettings();
    return this.cache;
  }

  /** Updates are serialized: two saves at once must not both start from the same old state. */
  update(patch: Partial<Settings>): Promise<Settings> {
    const run = this.queue.then(async () => {
      const current = await this.get();
      const next = settingsSchema.parse({ ...current, ...patch });
      await writeFileAtomic(this.file, JSON.stringify(next, null, 2));
      this.cache = next;
      return next;
    });
    this.queue = run.catch(() => undefined);
    return run;
  }
}
