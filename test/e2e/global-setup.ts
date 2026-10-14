import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { startFakeDockerApi } from '../fakes/fake-docker/api.mjs';
import { startFakeGithub } from '../fakes/fake-github/server.mjs';
import { demoRepos, startFakeHub } from '../fakes/fake-hub/hub.mjs';

export const ROOT = path.resolve(import.meta.dirname, '../..');
export const E2E_ENV_FILE = path.join(ROOT, '.qa', 'e2e-env.json');

/**
 * Starts the fake world the app talks to during E2E and records how to reach it for launchApp():
 *  - GitHub releases for llama.cpp. The "llama-server" inside the archives is a tiny Node stub that
 *    runs the fake engine, so install → benchmark runs end to end with GPUBENCH_LLAMA_LAUNCHER=[node].
 *  - Hugging Face (search, files, gated repos, signed CDN downloads with Range).
 *  - Docker: the Engine API on a named pipe / unix socket (the CLI fake is set per app in launchApp).
 * Nothing in E2E touches the network, the real GPU or the real Docker.
 */
export default async function globalSetup(): Promise<() => Promise<void>> {
  // The electron package has no install script any more: its binary is unzipped into
  // node_modules/electron/dist the first time `require('electron')` runs. Left to the workers, two of
  // them unzip it at once after a fresh `npm ci`, and one starts the binary while the other is still
  // writing it (spawn ETXTBSY on Linux). Here it happens once, before any worker starts.
  createRequire(import.meta.url)('electron');
  const cli = path.join(ROOT, 'test', 'fakes', 'fake-engine', 'cli.mjs');
  const github = await startFakeGithub({ serverBinaryData: `import(${JSON.stringify(pathToFileURL(cli).href)});\n` });
  const hub = await startFakeHub({ repos: demoRepos() });
  const dockerApi = await startFakeDockerApi({
    images: {
      'ghcr.io/ggml-org/llama.cpp:server-cuda': { Id: 'sha256:llama', RepoTags: ['ghcr.io/ggml-org/llama.cpp:server-cuda'], RepoDigests: ['ghcr.io/ggml-org/llama.cpp@sha256:1111'], Size: 2_900_000_000 },
    },
  });
  mkdirSync(path.dirname(E2E_ENV_FILE), { recursive: true });
  writeFileSync(
    E2E_ENV_FILE,
    JSON.stringify(
      {
        GPUBENCH_GITHUB_API: github.url,
        GPUBENCH_HF_ENDPOINT: hub.url,
        GPUBENCH_DOCKER_HOST: dockerApi.socketPath,
      },
      null,
      2,
    ),
  );
  return async () => {
    await Promise.all([github.close(), hub.close(), dockerApi.close()]);
  };
}
