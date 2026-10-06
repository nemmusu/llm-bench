import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { startFakeGithub } from '../fakes/fake-github/server.mjs';

export const ROOT = path.resolve(import.meta.dirname, '../..');
export const E2E_ENV_FILE = path.join(ROOT, '.qa', 'e2e-env.json');

/**
 * Starts the fake internet the app talks to during E2E (GitHub releases for llama.cpp; the HF hub
 * joins later) and records the URLs for launchApp(). The "llama-server" inside the fake release
 * archives is a tiny Node stub that runs the fake engine, so the install → benchmark journey runs
 * end to end with GPUBENCH_LLAMA_LAUNCHER=[node].
 */
export default async function globalSetup(): Promise<() => Promise<void>> {
  const cli = path.join(ROOT, 'test', 'fakes', 'fake-engine', 'cli.mjs');
  const github = await startFakeGithub({ serverBinaryData: `import(${JSON.stringify(pathToFileURL(cli).href)});\n` });
  mkdirSync(path.dirname(E2E_ENV_FILE), { recursive: true });
  writeFileSync(E2E_ENV_FILE, JSON.stringify({ GPUBENCH_GITHUB_API: github.url }, null, 2));
  return async () => {
    await github.close();
  };
}
