#!/usr/bin/env node
// Stand-in for the `vllm` console script in tests of the native vLLM adapter: `--version` prints
// like vLLM (log noise, then the bare version); `serve …` runs the fake engine in vLLM mode.
if (process.argv[2] === '--version') {
  process.stdout.write('INFO 10-06 10:00:00 [__init__.py:216] Automatically detected platform cuda.\n0.31.0\n');
  process.exit(0);
}
// The fake engine reads process.argv.slice(2): ["serve", <model>, …] selects its vLLM flavour.
await import(new URL('../../fakes/fake-engine/cli.mjs', import.meta.url).href);
