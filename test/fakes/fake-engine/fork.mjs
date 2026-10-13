#!/usr/bin/env node
// A llama.cpp fork (PrismML-like) for E2E and mockups: the fake engine in fork mode — its own
// --version (build 7001), no -ub, an extra --ternary-kernels option. Run with `node fork.mjs …`.
process.env.FAKE_ENGINE_HELP = 'fork';
await import('./cli.mjs');
