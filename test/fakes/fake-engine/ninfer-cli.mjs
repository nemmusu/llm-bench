#!/usr/bin/env node
// Command-line twin of NInfer's ninfer-serve: `node ninfer-cli.mjs <model.ninfer> [options]` (the fake wsl.exe
// runs it for any …/ninfer-serve). --help prints the real help (test/fixtures/ninfer/help.stdout.txt);
// unknown options and --no-prefix-reuse with a context-cache size fail like the real one.
//
// Environment: FAKE_ENGINE_PROFILE (timings; `ninfer` = its memory: freeMiB, weightsMiB, runtimeMiB),
// FAKE_NVIDIA_SMI_STATE (fake nvidia-smi updated while it loads and generates).
import { readFileSync } from 'node:fs';
import { readProfile } from './server.mjs';
import { startFakeNinfer } from './ninfer.mjs';

const HELP = new URL('../../fixtures/ninfer/help.stdout.txt', import.meta.url);
const argv = process.argv.slice(2);

/** Options of the help: name → takes a value. */
export function ninferFlags(help) {
  const flags = new Map();
  for (const m of help.matchAll(/\[(--[a-z][a-z0-9-]*)( [^\]|]+(?:\|[^\]]+)?)?/g)) flags.set(m[1], m[2] !== undefined && !m[2].startsWith(' --'));
  // "[--spec mtp|dflash|dflash2 --draft-tokens N]": both take a value.
  flags.set('--spec', true);
  flags.set('--draft-tokens', true);
  return flags;
}

const err = (line) => process.stderr.write(`${line}\n`);

async function main() {
  const help = readFileSync(HELP, 'utf8');
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(help);
    return 0;
  }
  const flags = ninferFlags(help);
  const model = argv[0];
  if (!model || model.startsWith('-')) {
    err('error: missing <model.ninfer>');
    return 2;
  }
  const val = {};
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (!flags.has(a)) {
      err(`error: unknown option '${a}'`);
      return 2;
    }
    val[a] = flags.get(a) ? argv[++i] : true;
  }
  const cacheFlags = ['--device-state-slots', '--host-state-slots', '--host-kv-mib', '--max-private-continuations', '--max-shared-prefixes', '--max-long-anchors-per-continuation'];
  if (val['--no-prefix-reuse'] && cacheFlags.some((f) => val[f] !== undefined)) {
    err('error: --no-prefix-reuse cannot be combined with context-cache capacity flags');
    return 2;
  }
  const num = (k) => (val[k] === undefined ? undefined : Number(val[k]));
  const capacity = val['--kv-capacity'];
  let engine;
  try {
    engine = await startFakeNinfer({
      model,
      host: val['--host'] ?? '127.0.0.1',
      port: num('--port') ?? 8080,
      modelId: val['--model-id'],
      maxContext: num('--max-context') ?? 8192,
      ...(capacity !== undefined ? { kvCapacity: capacity === 'auto' ? 'auto' : Number(capacity) } : {}),
      concurrency: num('--max-concurrency') ?? 1,
      kvDtype: val['--kv-dtype'] ?? 'bf16',
      spec: val['--spec'] ?? 'off',
      vision: val['--vision'] === true,
      prefixReuse: val['--no-prefix-reuse'] !== true,
      statsMs: num('--log-stats-interval-ms') ?? 5000,
      profile: readProfile(process.env),
      log: (l) => process.stderr.write(`${l}\n`),
      ...(process.env.FAKE_NVIDIA_SMI_STATE ? { stateFile: process.env.FAKE_NVIDIA_SMI_STATE } : {}),
      onFatal: (code) => process.exit(code),
    });
  } catch {
    return 1;
  }
  const shutdown = () => void engine.close().then(() => process.exit(0));
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  return undefined;
}

main().then(
  (code) => {
    if (code !== undefined) process.exitCode = code;
  },
  (e) => {
    process.stderr.write(`fake-ninfer: ${e?.stack ?? e}\n`);
    process.exit(70);
  },
);
