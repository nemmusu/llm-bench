import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import type { FakeRepoSpec } from '../../fakes/fake-hub/hub.mjs';
import { llamaLikeGguf } from '../../fakes/fake-hub/model-files.mjs';
import { expect, launchApp, test } from '../fixtures';
import { h1, newUserData, openPage, scan, skipWelcome, startLibraryWorld, stubDesktop, type LibraryWorld } from './library-helpers';

/**
 * A person downloads a quant and forgets the vision part, adds it later from the library (only the
 * mmproj moves), then the repo changes on Hugging Face and "Aggiorna" fetches only the changed file.
 */
test.describe.configure({ timeout: 180_000 });

let world: LibraryWorld;
const REPO = 'eye/Tiny-Eye-GGUF';
const MAIN = 'Tiny-Eye-Q4_K_M.gguf';
const MMPROJ = 'mmproj-Tiny-Eye-F16.gguf';

/** The repo as it is now; `version` 2 is a new revision whose quant changed (another content, another size). */
function eye(version: 1 | 2): FakeRepoSpec {
  return {
    id: REPO,
    sha: version === 1 ? '1'.repeat(40) : '2'.repeat(40),
    downloads: 700,
    likes: 9,
    license: 'apache-2.0',
    pipelineTag: 'image-text-to-text',
    numParameters: 600_000_000,
    tags: ['gguf'],
    readme: '# Tiny eye\n',
    files: [
      { path: MAIN, gguf: { ...llamaLikeGguf({ name: 'Tiny Eye', sizeLabel: '0.6B' }), totalSize: (version === 1 ? 96 : 128) * 1024, seed: version } },
      { path: MMPROJ, gguf: { metadata: { 'general.architecture': 'clip', 'general.type': 'mmproj' }, totalSize: 12 * 1024 } },
    ],
  };
}

test.beforeAll(async () => {
  world = await startLibraryWorld();
  world.hub.addRepo(eye(1));
});

test.afterAll(async () => {
  await world.close();
});

/** Files fetched since `from` (hub resolve and CDN requests), by name. */
const fetched = (from: number) =>
  world.hub.requests
    .slice(from)
    .filter((r) => r.url.includes('/resolve/') || r.url.startsWith('/cdn/'))
    .map((r) => decodeURIComponent(r.url.split('?')[0]?.split('/').pop() ?? ''));

test('a quant without its mmproj, "Aggiungi la parte visione" later, then "Aggiorna" after the repo changed', async () => {
  const userData = newUserData();
  const dest = path.join(userData, 'models', 'eye', 'Tiny-Eye-GGUF');
  const gb = await launchApp({ env: world.env, userData });
  try {
    const { page } = gb;
    await stubDesktop(gb);
    await skipWelcome(page);
    await openPage(page, 'Modelli');
    await page.getByRole('tab', { name: 'Scarica' }).click();
    await page.getByRole('complementary', { name: 'Filtri' }).getByRole('radio', { name: 'Tutti', exact: true }).click();
    await page.getByRole('searchbox', { name: 'Cerca un modello su Hugging Face' }).fill('tiny-eye');
    await page.getByRole('list', { name: 'Modelli trovati' }).getByRole('link', { name: REPO, exact: true }).click();
    await expect(h1(page, 'Tiny-Eye-GGUF')).toBeVisible();

    // The quant alone: the vision part stays unticked.
    const extra = page.getByRole('checkbox', { name: new RegExp(MMPROJ.replace(/\./g, '\\.')) });
    await expect(extra).not.toBeChecked({ timeout: 30_000 });
    await page.getByRole('button', { name: /^Scarica Q4_K_M · / }).click();
    await page.getByRole('dialog', { name: /^Scaricare Tiny-Eye-GGUF · Q4_K_M\?$/ }).getByRole('button', { name: /^Scarica · / }).click();
    await expect.poll(() => statSync(path.join(dest, MAIN), { throwIfNoEntry: false })?.size, { timeout: 30_000 }).toBe(world.hub.file(REPO, MAIN).size);
    const mainTime = statSync(path.join(dest, MAIN)).mtimeMs;

    // The library offers the part the repo has and the PC does not.
    await page.getByRole('link', { name: 'Modelli', exact: true }).first().click();
    await page.getByRole('tab', { name: /Sul tuo PC/ }).click();
    const gguf = page.getByRole('list', { name: 'Per llama.cpp (GGUF)' });
    const row = gguf.getByRole('listitem').filter({ hasText: 'Tiny-Eye-Q4_K_M' });
    const add = row.getByRole('button', { name: /^Aggiungi la parte visione \(mmproj, .+\): Tiny-Eye-Q4_K_M$/ });
    await expect(add).toBeVisible({ timeout: 30_000 });
    await scan(page, 'library with a missing vision part');
    const before = world.hub.requests.length;
    await add.click();
    const dialog = page.getByRole('dialog', { name: /^Scaricare Tiny-Eye-Q4_K_M · visione\?$/ });
    await expect(dialog.getByText(/^Il modello è già sul PC: scarico solo la parte visione \(mmproj\) \(.+\)\.$/)).toBeVisible({ timeout: 20_000 });
    await expect(dialog.getByText(dest, { exact: true })).toBeVisible();
    await dialog.getByRole('button', { name: /^Scarica · / }).click();
    await expect.poll(() => statSync(path.join(dest, MMPROJ), { throwIfNoEntry: false })?.size, { timeout: 30_000 }).toBe(world.hub.file(REPO, MMPROJ).size);
    // Only the mmproj moved: the model was not fetched again (same file, same time).
    expect(new Set(fetched(before))).toEqual(new Set([MMPROJ]));
    expect(statSync(path.join(dest, MAIN)).mtimeMs).toBe(mainTime);
    // The model now has its vision part, and nothing more to add.
    await expect(row.getByText('Visione (mmproj)', { exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(add).toHaveCount(0);

    // A new revision on Hugging Face changes the quant.
    world.hub.addRepo(eye(2));
    const check = page.getByRole('button', { name: 'Controlla aggiornamenti' });
    await check.click();
    await expect(row.getByText('Aggiornamento disponibile')).toBeVisible({ timeout: 30_000 });
    await expect(row.getByText(/^Il file Q4_K_M è cambiato \(.+ → .+\)$/)).toBeVisible();
    await scan(page, 'library with an update');
    const beforeUpdate = world.hub.requests.length;
    await row.getByRole('button', { name: 'Aggiorna: Tiny-Eye-Q4_K_M' }).click();
    const update = page.getByRole('dialog', { name: /^Scaricare Tiny-Eye-Q4_K_M · aggiornamento\?$/ });
    await expect(update.getByText(/Il file che hai resta finché quello nuovo non è scaricato e verificato/)).toBeVisible({ timeout: 20_000 });
    await update.getByRole('button', { name: /^Scarica · / }).click();
    await expect.poll(() => statSync(path.join(dest, MAIN)).size, { timeout: 30_000 }).toBe(world.hub.file(REPO, MAIN).size);
    expect(readFileSync(path.join(dest, MAIN)).equals(world.hub.file(REPO, MAIN).bytes)).toBe(true);
    // Only the changed file: the mmproj stayed as it was.
    expect(new Set(fetched(beforeUpdate))).toEqual(new Set([MAIN]));
    await expect(row.getByText('Aggiornamento disponibile')).toHaveCount(0, { timeout: 30_000 });
    await expect(row.getByText('Visione (mmproj)', { exact: true })).toBeVisible();
  } finally {
    await gb.close();
  }
});
