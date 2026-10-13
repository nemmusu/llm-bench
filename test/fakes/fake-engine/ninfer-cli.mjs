#!/usr/bin/env node
// Command-line twin of NInfer's ninfer-serve: `node ninfer-cli.mjs <model.ninfer> [options]` (the fake wsl.exe
// runs it for any …/ninfer-serve). --help prints the real help (test/fixtures/ninfer/help.stdout.txt, or
// NInfer-all's help-all.stdout.txt); unknown options, a KV type the build does not have and --no-prefix-reuse
// with a context-cache size fail like the real one. An artifact with "gguf" in its path keeps GGUF's blocks
// (tensor layout gguf_blocks_v1): the official build stops at start-up as the real one did, NInfer-all reads it.
//
// Environment: FAKE_ENGINE_PROFILE (timings; `ninfer` = its memory: freeMiB, weightsMiB, runtimeMiB),
// FAKE_NVIDIA_SMI_STATE (fake nvidia-smi updated while it loads and generates), FAKE_NINFER_VARIANT ('all' =
// NInfer-all: its help, its KV types, GGUF-NInfer artifacts).
import { readFileSync } from 'node:fs';
import { readProfile } from './server.mjs';
import { ninferLog, startFakeNinfer } from './ninfer.mjs';

const ALL = process.env.FAKE_NINFER_VARIANT === 'all';
const HELP = new URL(`../../fixtures/ninfer/${ALL ? 'help-all' : 'help'}.stdout.txt`, import.meta.url);
const KV_DTYPES = ['bf16', 'int8', 'fp8', 'nvfp4', 'k8v4', ...(ALL ? ['rk8v4', 'rk4v4', 'rk4v4-e8', 'rk2v4-e8'] : [])];
const argv = process.argv.slice(2);

/** Options of the help: name → takes a value. */
export function ninferFlags(help) {
  const flags = new Map();
  for (const m of help.matchAll(/\[(--[a-z][a-z0-9-]*)( [^\]|]+(?:\|[^\]]+)?)?/g)) flags.set(m[1], m[2] !== undefined && !m[2].startsWith(' --'));
  // "[--spec mtp|dflash|dflash2 --draft-tokens N]": both take a value.
  // NInfer-all's option table: "  --kv-dtype T     KV storage: …" (a placeholder after the flag: it takes a value).
  for (const m of help.matchAll(/^ {2}(--[a-z][a-z0-9-]*)( [^\s-]\S*)?(?: {2,}|$)/gm)) flags.set(m[1], m[2] !== undefined);
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
  if (val['--kv-dtype'] !== undefined && !KV_DTYPES.includes(val['--kv-dtype'])) {
    err(`ninfer-serve: invalid kv-dtype: ${val['--kv-dtype']}`);
    return 2;
  }
  // GGUF's quantization blocks: only NInfer-all reads them (the official build stops while it plans the runtime).
  if (/gguf/i.test(model) && !ALL) {
    ninferLog(err, 'INFO', 'starting engine');
    ninferLog(err, 'ERROR', 'startup failed | planning runtime | 874 ms');
    ninferLog(err, 'FATAL', 'server failed during startup | weight/000130: unknown tensor layout: gguf_blocks_v1');
    return 1;
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
