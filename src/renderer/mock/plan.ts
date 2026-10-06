/**
 * Client-side stand-in for POST /api/runs/plan: turns the Benchmark choices into the exact
 * command preview. M1 replaces it with the core's planner (the single source of truth).
 */
import type { EngineKind } from '../../contract/engines';
import { formatCommand } from '../lib/command';
import type { ModelChoice } from './models';
import { LLAMACPP_BUILD } from './system';

export interface ExpertParams {
  ctx: string;
  ngl: string;
  flashAttention: 'auto' | 'on' | 'off';
  kvCache: 'auto' | 'f16' | 'q8_0' | 'q4_0';
  batch: string;
  ubatch: string;
  threads: string;
  parallel: string;
  promptLengths: string;
  outputTokens: string;
  repetitions: string;
  concurrency: string;
  extraArgs: string;
  env: string;
  executable: string;
  image: string;
}

export const DEFAULT_EXPERT: ExpertParams = {
  ctx: '',
  ngl: '',
  flashAttention: 'on',
  kvCache: 'auto',
  batch: '',
  ubatch: '',
  threads: '',
  parallel: '',
  promptLengths: '',
  outputTokens: '',
  repetitions: '',
  concurrency: '',
  extraArgs: '',
  env: '',
  executable: '',
  image: '',
};

export const DEFAULT_IMAGES: Partial<Record<EngineKind, string>> = {
  'llamacpp-docker': 'ghcr.io/ggml-org/llama.cpp:server-cuda',
  'vllm-docker': 'vllm/vllm-openai:v0.12.0',
};

const MANAGED_EXE = `C:\\Users\\utente\\AppData\\Roaming\\GPU Bench\\engines\\llama.cpp\\${LLAMACPP_BUILD}\\llama-server.exe`;
const PORT = '41873';
const ALIAS = 'gpubench-3f9c2a';

/** "NAME=value" lines → record (invalid lines ignored). */
export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line);
    if (m) out[m[1]!] = m[2]!.trim();
  }
  return out;
}

function splitArgs(text: string): string[] {
  return text
    .split(/\r?\n/)
    .flatMap((l) => l.trim().split(/\s+/))
    .filter(Boolean);
}

function llamaArgs(p: ExpertParams, modelPath: string): string[] {
  const args = ['--model', modelPath, '--ctx-size', p.ctx || '8192', '--n-gpu-layers', p.ngl || '99'];
  if (p.flashAttention !== 'auto') args.push('--flash-attn', p.flashAttention);
  if (p.kvCache !== 'auto' && p.kvCache !== 'f16') args.push('--cache-type-k', p.kvCache, '--cache-type-v', p.kvCache);
  args.push('--batch-size', p.batch || '2048', '--ubatch-size', p.ubatch || '512');
  if (p.threads) args.push('--threads', p.threads);
  args.push('--parallel', p.parallel || '1');
  return args;
}

export interface CommandPreview {
  argv: string[];
  env: Record<string, string>;
  powershell: string;
  bash: string;
}

export function previewCommand(engine: EngineKind, model: ModelChoice, p: ExpertParams): CommandPreview {
  const file = model.file ?? `${model.name.replaceAll(' ', '-')}-${model.quant}.gguf`;
  const env = parseEnv(p.env);
  const extra = splitArgs(p.extraArgs);
  let argv: string[];
  switch (engine) {
    case 'llamacpp-docker':
      argv = [
        'docker', 'run', '--rm', '--gpus', 'all', '--name', ALIAS, '--label', 'gpubench=1',
        '-p', `127.0.0.1:${PORT}:8080`, '-v', 'C:\\models:/models:ro',
        p.image || DEFAULT_IMAGES['llamacpp-docker']!,
        ...llamaArgs(p, `/models/${file}`), '--host', '0.0.0.0', '--port', '8080', ...extra,
      ];
      break;
    case 'vllm-docker':
      argv = [
        'docker', 'run', '--rm', '--gpus', 'all', '--ipc=host', '--name', ALIAS, '--label', 'gpubench=1',
        '-p', `127.0.0.1:${PORT}:8000`, '-v', 'gpubench-hf-cache:/root/.cache/huggingface',
        p.image || DEFAULT_IMAGES['vllm-docker']!,
        '--model', model.repo ?? 'Qwen/Qwen3-8B', '--max-model-len', p.ctx || '8192',
        '--gpu-memory-utilization', '0.90', '--max-num-seqs', p.parallel || '16', ...extra,
      ];
      break;
    case 'vllm-native':
      argv = ['vllm', 'serve', model.repo ?? 'Qwen/Qwen3-8B', '--host', '127.0.0.1', '--port', PORT, '--max-model-len', p.ctx || '8192', ...extra];
      break;
    case 'external':
      argv = ['curl', `http://127.0.0.1:8080/v1/models`];
      break;
    default:
      argv = [
        p.executable || MANAGED_EXE,
        ...llamaArgs(p, `C:\\models\\${file}`),
        '--host', '127.0.0.1', '--port', PORT, '--fit', 'off', '--no-webui', '--alias', ALIAS, ...extra,
      ];
  }
  return { argv, env, powershell: formatCommand(argv, 'powershell', env), bash: formatCommand(argv, 'bash', env) };
}
