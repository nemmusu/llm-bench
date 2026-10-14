/**
 * The launch settings each engine takes, in the order the expert panel and "Avvia un server" show them,
 * with the flag each one becomes in its command (core/engines: llamacpp-native/args.ts, shared/vllm-args.ts,
 * shared/sglang.ts, ninfer/args.ts + contract/ninfer.ts ninferFlags). One list for the fields shown, the
 * values sent (expert-form.ts paramsFromForm reads only these) and the fields a fork lacks (its check's
 * missing flags name the same `setting`): a setting an engine ignores is never offered for it.
 *
 *   llama.cpp  -c -ngl -fa -ctk/-ctv -b -ub -t -np, YaRN (--rope-scaling …)
 *   vLLM       --max-model-len --gpu-memory-utilization --max-num-seqs --kv-cache-dtype
 *              --max-num-batched-tokens --dtype --quantization, YaRN (--hf-overrides)
 *   SGLang     --context-length --mem-fraction-static --max-running-requests --kv-cache-dtype
 *              --chunked-prefill-size --dtype --quantization, YaRN (--json-model-override-args)
 *   NInfer     --max-context --max-concurrency --kv-capacity --kv-dtype --spec --draft-tokens
 *              --lm-head-draft --vision, prefix reuse (--no-prefix-reuse, else the cache slots),
 *              --no-thinking --preserve-thinking. No YaRN: NInfer has no RoPE scaling flag.
 *   TensorRT-LLM --max_seq_len --kv_cache_dtype --kv_cache_free_gpu_memory_fraction --max_batch_size
 *              --max_num_tokens --tp_size --trust_remote_code (core/engines/shared/trtllm.ts trtllmServeArgs). No YaRN, no
 *              dtype or quantization: trtllm-serve reads them from the checkpoint.
 *   every one  image input and reasoning (vision / reasoning; NInfer: --vision, --no-thinking): two switches.
 */
import { COMMAND_SETTINGS, commandSettings } from '../../../contract/custom-engines';
import type { EngineBase } from '../../../contract/engines';
import type { ParamsField } from './params-form';

/** The engines with launch settings (an external server or a command template has none of these). */
export type LaunchBase = Exclude<EngineBase, 'external'>;

export interface LaunchField {
  /** The form field ('yarnTarget' = the YaRN choice, which sets the context too). */
  field: ParamsField;
  /** The flag it becomes, as the command shows it. */
  flag: string;
  /** The launch setting it carries: the `setting` of a fork's missing flag (core/engines/shared/standard-flags.ts). */
  setting: string;
}

const f = (field: ParamsField, flag: string, setting: string = field): LaunchField => ({ field, flag, setting });

/**
 * Image input and reasoning (LaunchParams.vision / reasoning): the page's two switches, not fields of the
 * grid. How each engine turns them off is the adapters' (no flag is named here); NInfer has its own two.
 */
const SWITCHES: readonly LaunchField[] = [f('vision', ''), f('reasoning', '')];

export const LAUNCH_FIELDS: Record<LaunchBase, readonly LaunchField[]> = {
  llamacpp: [
    f('contextSize', '-c'),
    f('gpuLayers', '-ngl'),
    f('flashAttention', '-fa'),
    f('kvCacheType', '-ctk / -ctv'),
    f('batchSize', '-b'),
    f('ubatchSize', '-ub'),
    f('threads', '-t'),
    f('parallel', '-np'),
    f('yarnTarget', '--rope-scaling yarn', 'ropeScaling'),
    ...SWITCHES,
  ],
  vllm: [
    f('maxModelLen', '--max-model-len', 'contextSize'),
    f('gpuMemoryUtilization', '--gpu-memory-utilization'),
    f('parallel', '--max-num-seqs'),
    f('kvCacheType', '--kv-cache-dtype'),
    f('batchSize', '--max-num-batched-tokens'),
    f('dtype', '--dtype'),
    f('quantization', '--quantization'),
    f('yarnTarget', '--hf-overrides', 'ropeScaling'),
    ...SWITCHES,
  ],
  sglang: [
    f('maxModelLen', '--context-length', 'contextSize'),
    f('gpuMemoryUtilization', '--mem-fraction-static'),
    f('parallel', '--max-running-requests'),
    f('kvCacheType', '--kv-cache-dtype'),
    f('batchSize', '--chunked-prefill-size'),
    f('dtype', '--dtype'),
    f('quantization', '--quantization'),
    f('yarnTarget', '--json-model-override-args', 'ropeScaling'),
    ...SWITCHES,
  ],
  ninfer: [
    f('contextSize', '--max-context'),
    f('parallel', '--max-concurrency'),
    f('ninferKvCapacity', '--kv-capacity', 'ninfer.kvCapacity'),
    f('ninferKvDtype', '--kv-dtype', 'ninfer.kvDtype'),
    f('ninferSpec', '--spec', 'ninfer.spec'),
    f('ninferDraftTokens', '--draft-tokens', 'ninfer.draftTokens'),
    f('ninferLmHeadDraft', '--lm-head-draft', 'ninfer.lmHeadDraft'),
    f('ninferVision', '--vision', 'ninfer.vision'),
    f('ninferPrefixReuse', '--no-prefix-reuse', 'ninfer.prefixReuse'),
    f('ninferDeviceStateSlots', '--device-state-slots', 'ninfer.deviceStateSlots'),
    f('ninferHostStateSlots', '--host-state-slots', 'ninfer.hostStateSlots'),
    f('ninferHostKvMib', '--host-kv-mib', 'ninfer.hostKvMib'),
    f('ninferThinking', '--no-thinking', 'ninfer.thinking'),
    f('ninferPreserveThinking', '--preserve-thinking', 'ninfer.preserveThinking'),
  ],
  trtllm: [
    f('maxModelLen', '--max_seq_len', 'contextSize'),
    f('kvCacheType', '--kv_cache_dtype'),
    f('trtllmKvMemory', '--kv_cache_free_gpu_memory_fraction', 'trtllm.kvCacheFreeMemoryFraction'),
    f('parallel', '--max_batch_size'),
    f('batchSize', '--max_num_tokens'),
    f('trtllmTp', '--tp_size', 'trtllm.tensorParallel'),
    f('trtllmTrustRemoteCode', '--trust_remote_code', 'trtllm.trustRemoteCode'),
    ...SWITCHES,
  ],
};

/** The fields of an engine ('external': none). */
export function fieldsOf(base: EngineBase): readonly LaunchField[] {
  return base === 'external' ? [] : LAUNCH_FIELDS[base];
}

/** The field of an engine, when it takes it. */
export function fieldOf(base: EngineBase, field: ParamsField): LaunchField | undefined {
  return fieldsOf(base).find((x) => x.field === field);
}

/** A program with an OpenAI API: the fields of the settings its commands take (contract/custom-engines.ts COMMAND_SETTINGS). */
export function commandFields(run: Parameters<typeof commandSettings>[0]): ParamsField[] {
  return commandSettings(run).map((s) => COMMAND_SETTINGS[s]);
}
