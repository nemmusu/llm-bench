/**
 * The fake world of the setup & library journeys: a Hugging Face with the curated reference model
 * (so "Configurazione consigliata" can really download it), throttling knobs for pause/resume,
 * Docker Hub tag lists for vLLM and SGLang, and stubs for the native dialogs and the system browser.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { demoRepos, startFakeHub } from '../../fakes/fake-hub/hub.mjs';
import { llamaLikeGguf } from '../../fakes/fake-hub/model-files.mjs';
import { ROOT, type AppHandle } from '../fixtures';

export interface LibraryWorld {
  env: Record<string, string>;
  hub: Awaited<ReturnType<typeof startFakeHub>>;
  close(): Promise<void>;
}

const curated = JSON.parse(readFileSync(path.join(ROOT, 'resources', 'curated-models.json'), 'utf8')) as {
  reference: { repo: string; file: string; revision: string };
};
export const REFERENCE = curated.reference;

/** Fake HF (demo repos + the curated reference model) and a fake Docker Hub, as env for launchApp. */
export async function startLibraryWorld(): Promise<LibraryWorld> {
  const hub = await startFakeHub({
    repos: [
      ...demoRepos(),
      {
        id: REFERENCE.repo,
        sha: REFERENCE.revision,
        downloads: 800_000,
        likes: 500,
        license: 'apache-2.0',
        tags: ['gguf'],
        readme: '---\nlicense: apache-2.0\n---\n# Qwen3-4B-GGUF\n\nThe **reference** model of the LLM Bench score.\n',
        files: [{ path: REFERENCE.file, gguf: { ...llamaLikeGguf({ name: 'Qwen3 4B', sizeLabel: '4B' }), totalSize: 192 * 1024 } }],
      },
    ],
  });
  const tags = readFileSync(path.join(ROOT, 'test', 'fixtures', 'docker', 'hub-tags-vllm.json'));
  const sglangTags = readFileSync(path.join(ROOT, 'test', 'fixtures', 'docker', 'hub-tags-sglang.json'));
  const dockerHub = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end((req.url ?? '').includes('lmsysorg') ? sglangTags : tags);
  });
  await new Promise<void>((resolve) => dockerHub.listen(0, '127.0.0.1', resolve));
  const { port } = dockerHub.address() as { port: number };
  return {
    env: {
      GPUBENCH_HF_ENDPOINT: hub.url,
      GPUBENCH_DOCKERHUB: `http://127.0.0.1:${port}`,
      // The Docker Desktop installer size is read with a HEAD request: never the real site in tests.
      GPUBENCH_DOCKER_INSTALLER_URL: `http://127.0.0.1:${port}/Docker%20Desktop%20Installer.exe`,
    },
    hub,
    close: async () => {
      await hub.close();
      await new Promise<void>((resolve) => dockerHub.close(() => resolve()));
    },
  };
}

/**
 * Replaces the native folder/file pickers and the system browser/file manager in the main process:
 * pickers answer with `answer`, opened URLs and revealed paths are recorded for the test to read.
 */
export async function stubDesktop(handle: AppHandle, answer: string | null = null): Promise<void> {
  await handle.app.evaluate(({ dialog, shell }, value) => {
    const g = globalThis as unknown as { __gb: { opened: string[]; revealed: string[] } };
    g.__gb = { opened: [], revealed: [] };
    dialog.showOpenDialog = (async () => (value ? { canceled: false, filePaths: [value] } : { canceled: true, filePaths: [] })) as typeof dialog.showOpenDialog;
    shell.openExternal = (async (url: string) => {
      g.__gb.opened.push(url);
    }) as typeof shell.openExternal;
    shell.showItemInFolder = ((p: string) => {
      g.__gb.revealed.push(p);
    }) as typeof shell.showItemInFolder;
  }, answer);
}

export function opened(handle: AppHandle): Promise<string[]> {
  return handle.app.evaluate(() => (globalThis as unknown as { __gb: { opened: string[] } }).__gb.opened);
}

export function revealed(handle: AppHandle): Promise<string[]> {
  return handle.app.evaluate(() => (globalThis as unknown as { __gb: { revealed: string[] } }).__gb.revealed);
}

/** A fresh userData folder (for restarts) with an optional fake nvidia-smi state. */
export function newUserData(gpuState?: Record<string, unknown>): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'gpubench-e2e-lib-'));
  if (gpuState) writeFileSync(path.join(dir, 'fake-nvidia-smi.json'), JSON.stringify(gpuState));
  return dir;
}

export function h1(page: Page, name: string | RegExp) {
  return page.getByRole('heading', { level: 1, name });
}

/** WCAG 2.1 AA + best practices on what is on screen now (legacy mode: Electron cannot open axe's helper page). */
export async function scan(page: Page, label: string): Promise<void> {
  const results = await new AxeBuilder({ page }).setLegacyMode(true).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice']).analyze();
  const summary = results.violations.map((v) => `${v.id} (${v.impact}): ${v.nodes.map((n) => `${n.target.join(' ')} → ${n.failureSummary ?? ''}`).join(', ')}`);
  expect(summary, `axe violations on ${label}`).toEqual([]);
}

/**
 * Clicks the action of a toast the way a person does: the pointer goes onto the toast first, which
 * keeps it on screen (sonner pauses its 4-second timer while it is hovered), then the click. The E2E
 * window is never shown, so it paints about once a second, and Playwright's wait for a steady element
 * alone could outlast the toast.
 */
export async function clickToastAction(page: Page, label: string): Promise<void> {
  const action = page.getByRole('button', { name: label, exact: true });
  await expect(action).toBeVisible();
  const box = await action.boundingBox();
  expect(box, `the "${label}" toast is on screen`).not.toBeNull();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await action.click();
}

/** First launch lands on the wizard: skip it like a user in a hurry. */
export async function skipWelcome(page: Page): Promise<void> {
  await expect(h1(page, 'Benvenuto in LLM Bench')).toBeVisible();
  await page.getByRole('button', { name: 'Salta, lo farò dopo' }).click();
  await expect(h1(page, 'Benchmark')).toBeVisible();
}

/** Opens a page from the sidebar, the way a person would. */
export async function openPage(page: Page, link: string, heading: string | RegExp = link): Promise<void> {
  await page.getByRole('navigation', { name: /Navigazione principale|Main navigation/ }).getByRole('link', { name: link }).click();
  await expect(h1(page, heading)).toBeVisible();
}
