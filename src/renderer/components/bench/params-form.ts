/** The expert form's fields as typed (text while the user types; expert-form.ts turns them into launch params). */
import type { NinferSpec } from '../../../contract/engines';

/** A yes/no setting that may also be left to the engine (or to LLM Bench for a test): 'default'. */
export type Tri = 'default' | 'on' | 'off';

export interface ParamsForm {
  contextSize: string;
  gpuLayers: string;
  flashAttention: 'default' | 'auto' | 'on' | 'off';
  /** 'default', f16 / q8_0 / q4_0, or a type the fork lists (turbo3…: kv-cache-options.ts); vLLM / SGLang: 'default' or fp8. */
  kvCacheType: string;
  batchSize: string;
  ubatchSize: string;
  threads: string;
  parallel: string;
  gpuMemoryUtilization: string;
  maxModelLen: string;
  dtype: string;
  quantization: string;
  extraArgs: string;
  env: string;
  /**
   * "Contesto oltre il limite del modello (YaRN)": the context to reach, tokens ('' = no), and the
   * trained context it starts from ('' = the model's own).
   */
  yarnTarget: string;
  yarnOriginal: string;
  /** NInfer's own settings (LaunchParams.ninfer): '' / 'default' = NInfer's default (or LLM Bench's for a test). */
  ninferKvCapacity: string;
  ninferKvDtype: string;
  ninferSpec: 'default' | NinferSpec;
  ninferDraftTokens: string;
  ninferLmHeadDraft: Tri;
  ninferVision: Tri;
  ninferPrefixReuse: Tri;
  ninferDeviceStateSlots: string;
  ninferHostStateSlots: string;
  ninferHostKvMib: string;
  ninferThinking: Tri;
  ninferPreserveThinking: Tri;
  /** Image input and reasoning of the model (LaunchParams.vision / reasoning; NInfer: its own two fields). */
  vision: Tri;
  reasoning: Tri;
}

export type ParamsField = keyof ParamsForm;
