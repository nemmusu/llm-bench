#!/usr/bin/env node
// A llama.cpp fork with its own KV caches (TurboQuant-like) for tests and E2E: the fake engine whose
// --help lists turbo4, turbo3, turbo2, turbo1.5 and turbo3_tcq for -ctk / -ctv, with its own --version
// (build 7001). Its memory model stores each type at its bits per value. Run with `node turbo.mjs …`.
process.env.FAKE_ENGINE_HELP = 'turbo';
await import('./cli.mjs');
