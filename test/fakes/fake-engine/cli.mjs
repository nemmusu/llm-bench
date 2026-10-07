#!/usr/bin/env node
// Command-line twin of llama-server (default) or `vllm serve` (argv "serve <model>" or
// FAKE_ENGINE_FLAVOR=vllm). Run with plain `node cli.mjs …`.
//
// Environment:
//   FAKE_ENGINE_PROFILE      inline JSON or a path to a JSON file (see FakeProfile in server.mjs)
//   FAKE_ENGINE_COLD_MARKER  if this file exists the load is "cold" (loadMsCold) and the file is deleted
//   FAKE_NVIDIA_SMI_STATE    fake nvidia-smi state file updated while loading/generating
//   FAKE_ENGINE_FLAVOR       "llamacpp" | "vllm"
//   FAKE_ENGINE_ALLOW_MISSING_MODEL=1  do not fail when -m does not exist
import { readFileSync } from 'node:fs';
import { readProfile, startFakeEngine } from './server.mjs';

const FIXTURES = new URL('../../fixtures/llamacpp/', import.meta.url);
const argv = process.argv.slice(2);
const env = process.env;

/** Option table of the real b10997 --help: name → takes a value. */
function knownFlags(help) {
  const flags = new Map();
  for (const line of help.split(/\r?\n/)) {
    if (!/^-{1,2}[A-Za-z0-9]/.test(line)) continue;
    const re = /[ \t]*(-{1,2}[A-Za-z0-9][A-Za-z0-9_-]*)(,)?/y;
    const names = [];
    let pos = 0;
    for (;;) {
      re.lastIndex = pos;
      const m = re.exec(line);
      if (!m) break;
      names.push(m[1]);
      pos = re.lastIndex;
      if (!m[2]) break;
    }
    const takesValue = /^ \S/.test(line.slice(pos));
    for (const n of names) flags.set(n, takesValue);
  }
  return flags;
}

const err = (lines) => {
  for (const l of lines) process.stderr.write(`${l}\n`);
};

async function main() {
  const flavor = env.FAKE_ENGINE_FLAVOR === 'vllm' || argv[0] === 'serve' ? 'vllm' : 'llamacpp';
  const profile = readProfile(env);

  if (flavor === 'llamacpp') {
    if (argv.includes('--version')) {
      process.stderr.write(readFileSync(new URL('version.stderr.txt', FIXTURES), 'utf8'));
      return 0;
    }
    if (argv.includes('--help') || argv.includes('-h') || argv.includes('--usage')) {
      process.stdout.write(readFileSync(new URL('help.stdout.txt', FIXTURES), 'utf8'));
      return 0;
    }
  }

  const o = { flavor, log: (l) => process.stderr.write(`${l}\n`), profile };
  if (flavor === 'llamacpp') {
    const flags = knownFlags(readFileSync(new URL('help.stdout.txt', FIXTURES), 'utf8'));
    const val = {};
    for (let i = 0; i < argv.length; i++) {
      const a = argv[i];
      if (profile.badFlag && a === profile.badFlag) {
        err([`error: invalid argument: ${a}`]);
        return 1;
      }
      if (!flags.has(a)) {
        err([`error: invalid argument: ${a}`]);
        return 1;
      }
      if (flags.get(a)) {
        if (i + 1 >= argv.length) {
          err([`error: argument ${a} expected a value`]);
          return 1;
        }
        val[a] = argv[++i];
      } else val[a] = 'true';
    }
    const get = (...names) => names.map((n) => val[n]).find((v) => v !== undefined);
    const fa = get('-fa', '--flash-attn');
    if (fa !== undefined && !['on', 'off', 'auto'].includes(fa)) {
      err([`error while handling argument "${'-fa'}": invalid value`, '', 'to show complete usage, run with -h']);
      return 1;
    }
    o.model = get('-m', '--model') ?? 'models/7B/ggml-model-f16.gguf';
    o.host = get('--host') ?? '127.0.0.1';
    o.port = Number(get('--port') ?? 8080);
    // Like current llama-server: comma-separated aliases, the first one is the model's id.
    o.aliases = (get('-a', '--alias') ?? o.model).split(',');
    o.ctx = Number(get('-c', '--ctx-size') ?? 4096) || 4096;
    o.np = Number(get('-np', '--parallel') ?? -1);
    o.flashAttn = fa ?? 'auto';
    // What the memory model of the profile looks at (see FakeMemory in server.mjs).
    o.kvType = get('-ctk', '--cache-type-k') ?? 'f16';
    o.kvTypeV = get('-ctv', '--cache-type-v') ?? 'f16';
    o.ubatch = Number(get('-ub', '--ubatch-size') ?? 512);
    o.batch = Number(get('-b', '--batch-size') ?? 2048);
    const ncmoe = get('-ncmoe', '--n-cpu-moe');
    if (ncmoe !== undefined) o.nCpuMoe = Number(ncmoe);
    const ngl = get('-ngl', '--gpu-layers', '--n-gpu-layers');
    if (ngl !== undefined && /^\d+$/.test(ngl)) o.gpuLayers = Number(ngl);
    o.requireModelFile = env.FAKE_ENGINE_ALLOW_MISSING_MODEL !== '1';
  } else {
    const rest = argv[0] === 'serve' ? argv.slice(1) : argv;
    let model = rest[0] && !rest[0].startsWith('-') ? rest[0] : undefined;
    const val = {};
    const names = [];
    for (let i = model ? 1 : 0; i < rest.length; i++) {
      const a = rest[i];
      if (!a.startsWith('--')) continue;
      const next = rest[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        val[a] = next;
        i++;
        // --served-model-name takes several names (nargs="+").
        while (a === '--served-model-name' && rest[i + 1] !== undefined && !rest[i + 1].startsWith('--')) names.push(rest[++i]);
        if (a === '--served-model-name') names.unshift(next);
      } else val[a] = 'true';
    }
    model ??= val['--model'] ?? 'facebook/opt-125m';
    o.model = model;
    o.host = val['--host'] ?? '0.0.0.0';
    o.port = Number(val['--port'] ?? 8000);
    o.aliases = names.length > 0 ? names : [model];
    o.ctx = Number(val['--max-model-len'] ?? 4096);
    o.kvType = val['--kv-cache-dtype'] === 'fp8' ? 'fp8' : 'auto';
    o.kvTypeV = o.kvType;
    if (val['--max-num-batched-tokens'] !== undefined) o.ubatch = Number(val['--max-num-batched-tokens']);
    if (val['--gpu-memory-utilization'] !== undefined) o.gpuMemoryUtilization = Number(val['--gpu-memory-utilization']);
    o.eager = val['--enforce-eager'] !== undefined;
    // Prefix caching is on by default in vLLM V1; cached tokens are reported only when asked.
    if (val['--no-enable-prefix-caching']) o.prefixCaching = false;
    if (val['--enable-prompt-tokens-details']) o.promptTokensDetails = true;
  }
  if (env.FAKE_NVIDIA_SMI_STATE) o.stateFile = env.FAKE_NVIDIA_SMI_STATE;
  if (env.FAKE_ENGINE_COLD_MARKER) o.coldMarker = env.FAKE_ENGINE_COLD_MARKER;
  o.onFatal = (code) => process.exit(code);

  let engine;
  try {
    engine = await startFakeEngine(o);
  } catch {
    return 1;
  }
  const shutdown = () => {
    process.stderr.write('srv    operator(): operator(): cleaning up before exit...\n');
    void engine.close().then(() => process.exit(0));
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  process.on('SIGBREAK', shutdown);
  // Keep running until killed (the server keeps the event loop alive).
  return undefined;
}

main().then(
  (code) => {
    if (code !== undefined) process.exitCode = code;
  },
  (e) => {
    process.stderr.write(`fake-engine: ${e?.stack ?? e}\n`);
    process.exit(70);
  },
);
