/**
 * Three real "Trova le impostazioni migliori" runs compared on one RTX 5090 (test/fixtures/runs/tune:
 * names, paths, ids removed, telemetry and logs trimmed), as the user compared them:
 *  - vLLM NVFP4: its recommended combination fits 212 992 tokens (208K) and was measured with that
 *    context full; vLLM said its KV cache holds 214 491 tokens;
 *  - llama.cpp UD-Q4_K_XL (cancelled): its first combination fits 262 144 (256K), measured full;
 *  - llama.cpp Qwopus Q4_K_M: its first combination fits 256K, measured full.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { RunResult } from '../../../../src/contract/results';
import { parseRun } from '../../../../src/core/store/runs-repo';
import { HOST, HOST_ID } from './fixtures';

const DIR = path.resolve(import.meta.dirname, '../../../fixtures/runs/tune');

export const VLLM_ID = '01M4GXRQZS9SKTC0HBQXVLLM08';
export const LLAMA_ID = '01M4H30X6C8H55EFMBE6LLAMA0';
export const QWOPUS_ID = '01M4H5PMD3B0EWHZC7MKQWOPUS';

const load = (file: string): RunResult => parseRun(JSON.parse(readFileSync(path.join(DIR, file), 'utf8').replaceAll('__THIS_HOST_ID__', HOST_ID).replaceAll('__THIS_PC__', HOST)))!;

export const vllmTune = () => load('2026-10-09_18-10-53_compare-vllm-208k.json');
export const llamaTune = () => load('2026-10-09_19-42-43_compare-llamacpp-256k.json');
export const qwopusTune = () => load('2026-10-09_20-29-32_compare-qwopus-256k.json');

/** The three, oldest first (as the Compare page opens them). */
export const threeTunes = (): RunResult[] => [vllmTune(), llamaTune(), qwopusTune()];
