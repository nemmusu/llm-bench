import type { ApiFlavor } from '../../contract/engines';
import type { HttpDeps } from './http';
import { LlamaCppClient, type ClientOptions } from './llamacpp-client';
import { OpenAiClient } from './openai-client';
import type { InferenceClient } from './types';

export type { ClientOptions } from './llamacpp-client';
export type { HttpDeps } from './http';

/** Builds the inference client for an API flavor (engine adapters call this for their instances). */
export function createInferenceClient(
  flavor: ApiFlavor,
  baseUrl: string,
  deps: HttpDeps,
  opts: ClientOptions = {},
): InferenceClient {
  if (flavor === 'llamacpp') return new LlamaCppClient(baseUrl, deps, opts);
  return new OpenAiClient(flavor, baseUrl, deps, opts);
}
