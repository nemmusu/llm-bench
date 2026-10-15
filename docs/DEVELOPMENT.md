# LLM Bench for developers

[Back to the README](../README.md) · [User guide](GUIDE.md)

You need **Node.js 22** or newer.

```bash
npm install
npm run build        # main, preload and core (esbuild) + UI (Vite)
npm start            # opens the Electron app
npm run validate     # lint, types, architecture boundaries, unit and integration tests, E2E, 100% coverage
npm run ci:docker    # the same validation in a clean Linux container, on the current commit
npm run dist         # Windows installers (NSIS + portable) or Linux packages (.deb + AppImage)
```

- **CI.** There is no GitHub CI, on purpose: the CI is local. `npm run ci:docker` validates the current commit (`git HEAD`) on Linux, inside Docker, with the E2E tests under Xvfb (`-- --fast` skips them).
- **Releases.** Build the Windows installers with `npm run dist` and the Linux packages with `node scripts/dist-linux.mjs`, then attach them to a GitHub release (`gh release create vX.Y.Z dist/*.exe dist/linux/*`).
- **Linux packages from Windows.** `node scripts/dist-linux.mjs` builds the .deb and the AppImage in electron-builder's Docker image.
- **Screenshots.** `node scripts/mockups.mjs` renders the main screens into `.qa/mockups` (light and dark) with realistic data and fake services, without touching the real GPU, settings or models. `node scripts/mockups.mjs --only=readme` regenerates the images of the READMEs and the guides in `docs/screenshots/en` and `docs/screenshots/it`.

## Architecture

- `src/main`: the Electron shell (window, notification area, dialogs, encrypted secrets). On Windows the installed app creates its notification-area icon with a GUID derived from its executable's path (`trayGuid` in `src/main/shell.ts`): Windows keeps the icon of a process that was killed (an installer upgrade, a crash) until the mouse passes over it, and with its own slot a new start replaces that icon instead of adding another. Development and E2E runs use no GUID (their executable is Electron's own), and every way out of the app destroys the icon.
- `src/core`: a local HTTP server (127.0.0.1, with a per-session token) in a utility process: engines, models, downloads, benchmarks, GPU telemetry, Docker, servers.
- `src/renderer`: the React UI (its own design system, English and Italian).
- `src/contract`: the shared schemas (zod) and response types.

## Tests

- `test/unit`, `test/integration`: Vitest, with deterministic fake services in `test/fakes` (LLM engine, nvidia-smi, Docker, WSL, GitHub, Hugging Face).
- `test/e2e`: Playwright on the real Electron app, written the way a person would use it (visible roles and labels), with axe accessibility checks.
- `scripts/coverage.mjs` merges unit and E2E coverage: the bar is 100% on every file.

The video memory estimate is partly inspired by [llmfit](https://github.com/AlexsJones/llmfit) (MIT license).
