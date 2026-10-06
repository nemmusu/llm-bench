/**
 * Mock models. M1/M2 wiring:
 *   mockLocalModels       → GET /api/models/local
 *   mockRecommended       → curated-models.json + POST /api/models/fit + GET /api/runs/tried
 *   mockDownloads         → GET /api/downloads (+ download.update events)
 */
import type { DownloadJob, FitLevel, LocalModel } from '../../contract/models';
import { GIB, MIB } from './system';

export interface ModelChoice {
  /** Local model id, or a "repo/file" key for downloads. */
  id: string;
  name: string;
  quant: string;
  paramsB: number;
  sizeBytes: number;
  fit: FitLevel;
  needMiB: number;
  local: boolean;
  /** Generation speed already measured on this GPU, if any. */
  tried?: { tps: number; date: string };
  repo?: string;
  file?: string;
}

function local(id: string, file: string, name: string, quant: string, paramsB: number, sizeBytes: number, arch: string, ctx: number): LocalModel {
  return {
    id,
    identity: {
      displayName: name,
      format: 'gguf',
      source: 'local',
      file,
      files: [file],
      quant,
      sizeBytes,
      weakKey: `${file}|${quant}|${sizeBytes}`,
      path: `C:\\models\\${file}`,
      facts: { architecture: arch, paramsB, quant, contextLength: ctx },
    },
    paths: [`C:\\models\\${file}`],
    auxiliary: [],
    dir: 'C:\\models',
    origin: 'library',
    modifiedAt: '2026-09-28T14:12:00.000Z',
  };
}

export const mockLocalModels: LocalModel[] = [
  local('qwen3-8b-q4km', 'Qwen3-8B-Q4_K_M.gguf', 'Qwen3 8B', 'Q4_K_M', 8.2, Math.round(4.68 * GIB), 'qwen3', 40960),
  local('gemma4-31b-q4km', 'gemma-4-31B-it-Q4_K_M.gguf', 'Gemma 4 31B', 'Q4_K_M', 30.7, Math.round(17.4 * GIB), 'gemma4', 131072),
  local('mistral-small-24b-q4km', 'Mistral-Small-3.2-24B-Instruct-Q4_K_M.gguf', 'Mistral Small 3.2 24B', 'Q4_K_M', 23.6, Math.round(13.3 * GIB), 'llama', 131072),
];

export const mockRecommended: ModelChoice[] = [
  {
    id: 'qwen3-8b-q4km',
    name: 'Qwen3 8B',
    quant: 'Q4_K_M',
    paramsB: 8.2,
    sizeBytes: Math.round(4.68 * GIB),
    fit: 'perfect',
    needMiB: 6890,
    local: true,
    tried: { tps: 190.6, date: '2026-10-06T10:42:00.000Z' },
  },
  {
    id: 'gemma4-31b-q4km',
    name: 'Gemma 4 31B',
    quant: 'Q4_K_M',
    paramsB: 30.7,
    sizeBytes: Math.round(17.4 * GIB),
    fit: 'good',
    needMiB: 21480,
    local: true,
    tried: { tps: 58.3, date: '2026-10-05T18:10:00.000Z' },
  },
  {
    id: 'mistral-small-24b-q4km',
    name: 'Mistral Small 3.2 24B',
    quant: 'Q4_K_M',
    paramsB: 23.6,
    sizeBytes: Math.round(13.3 * GIB),
    fit: 'perfect',
    needMiB: 15900,
    local: true,
    tried: { tps: 74.9, date: '2026-10-04T20:55:00.000Z' },
  },
  {
    id: 'unsloth/Llama-3.1-8B-Instruct-GGUF/Llama-3.1-8B-Instruct-Q4_K_M.gguf',
    name: 'Llama 3.1 8B Instruct',
    quant: 'Q4_K_M',
    paramsB: 8.0,
    sizeBytes: Math.round(4.58 * GIB),
    fit: 'perfect',
    needMiB: 6720,
    local: false,
    repo: 'unsloth/Llama-3.1-8B-Instruct-GGUF',
    file: 'Llama-3.1-8B-Instruct-Q4_K_M.gguf',
  },
  {
    id: 'unsloth/Qwen3-30B-A3B-GGUF/Qwen3-30B-A3B-Q4_K_M.gguf',
    name: 'Qwen3 30B A3B',
    quant: 'Q4_K_M',
    paramsB: 30.5,
    sizeBytes: Math.round(17.3 * GIB),
    fit: 'good',
    needMiB: 20100,
    local: false,
    tried: { tps: 214.2, date: '2026-10-05T16:02:00.000Z' },
    repo: 'unsloth/Qwen3-30B-A3B-GGUF',
    file: 'Qwen3-30B-A3B-Q4_K_M.gguf',
  },
  {
    id: 'ggml-org/gpt-oss-20b-GGUF/gpt-oss-20b-mxfp4.gguf',
    name: 'gpt-oss 20B',
    quant: 'MXFP4',
    paramsB: 20.9,
    sizeBytes: Math.round(11.3 * GIB),
    fit: 'perfect',
    needMiB: 13700,
    local: false,
    repo: 'ggml-org/gpt-oss-20b-GGUF',
    file: 'gpt-oss-20b-mxfp4.gguf',
  },
  {
    id: 'bartowski/Qwen3-32B-GGUF/Qwen3-32B-Q5_K_M.gguf',
    name: 'Qwen3 32B',
    quant: 'Q5_K_M',
    paramsB: 32.8,
    sizeBytes: Math.round(21.6 * GIB),
    fit: 'tight',
    needMiB: 28900,
    local: false,
    repo: 'bartowski/Qwen3-32B-GGUF',
    file: 'Qwen3-32B-Q5_K_M.gguf',
  },
  {
    id: 'unsloth/Llama-3.3-70B-Instruct-GGUF/Llama-3.3-70B-Instruct-Q4_K_M.gguf',
    name: 'Llama 3.3 70B Instruct',
    quant: 'Q4_K_M',
    paramsB: 70.6,
    sizeBytes: Math.round(39.6 * GIB),
    fit: 'partial',
    needMiB: 44800,
    local: false,
    repo: 'unsloth/Llama-3.3-70B-Instruct-GGUF',
    file: 'Llama-3.3-70B-Instruct-Q4_K_M.gguf',
  },
];

export const mockDownloads: DownloadJob[] = [
  {
    id: 'dl-01',
    label: 'Qwen3 30B A3B · Q4_K_M',
    repo: 'unsloth/Qwen3-30B-A3B-GGUF',
    files: [{ path: 'Qwen3-30B-A3B-Q4_K_M.gguf', sizeBytes: Math.round(17.3 * GIB) }],
    dest: 'C:\\models',
    state: 'running',
    bytesDone: Math.round(11.2 * GIB),
    bytesTotal: Math.round(17.3 * GIB),
    bytesPerSec: 86 * MIB,
    etaSec: 73,
    createdAt: '2026-10-06T10:51:00.000Z',
  },
];

export function findChoice(id: string | undefined): ModelChoice {
  return mockRecommended.find((m) => m.id === id) ?? mockRecommended[0]!;
}
