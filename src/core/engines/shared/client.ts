import type { ApiFlavor } from '../../../contract/engines';
import type { InferenceClient } from '../../inference/types';

/**
 * Client factory that can also pin the served model name (vLLM: `--served-model-name <marker>`,
 * used by /tokenize and as the default `model` of every request). Same shape as
 * createInferenceClient's options; engines/instance.ts ClientFactory values are assignable to it.
 */
export type ModelClientFactory = (flavor: ApiFlavor, baseUrl: string, opts?: { apiKey?: string; model?: string }) => InferenceClient;
