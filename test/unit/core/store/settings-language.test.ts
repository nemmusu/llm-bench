import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultSettings } from '../../../../src/contract/settings';
import { SettingsRepo } from '../../../../src/core/store/settings-repo';
import { tempDir } from '../server/helpers';

describe('the language of a new install and of an existing one', () => {
  let t: ReturnType<typeof tempDir>;
  beforeEach(() => {
    t = tempDir();
  });
  afterEach(() => t.cleanup());

  it('a new install speaks English: no settings file, or one that never stored a language', async () => {
    expect(defaultSettings().language).toBe('en');
    expect((await new SettingsRepo(t.dir).get()).language).toBe('en');
    writeFileSync(path.join(t.dir, 'settings.json'), JSON.stringify({ onboardingDone: true, density: 'compact' }));
    expect(await new SettingsRepo(t.dir).get()).toMatchObject({ language: 'en', onboardingDone: true, density: 'compact' });
  });

  it('a stored Italian stays Italian, also after other changes are saved', async () => {
    writeFileSync(path.join(t.dir, 'settings.json'), JSON.stringify({ language: 'it', onboardingDone: true }));
    const repo = new SettingsRepo(t.dir);
    expect((await repo.get()).language).toBe('it');
    await repo.update({ theme: 'dark' });
    expect(JSON.parse(readFileSync(path.join(t.dir, 'settings.json'), 'utf8'))).toMatchObject({ language: 'it', theme: 'dark' });
  });
});
