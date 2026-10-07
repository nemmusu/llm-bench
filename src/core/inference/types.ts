import type { ApiFlavor } from '../../contract/engines';

/** Token counts and engine timings reported at the end of a streamed generation. */
export interface Usage {
  promptTokens?: number;
  completionTokens?: number;
}

/** llama.cpp `timings` object (all optional: other engines don't send it). */
export interface EngineTimings {
  promptN?: number;
  promptMs?: number;
  predictedN?: number;
  predictedMs?: number;
  draftN?: number;
  draftNAccepted?: number;
}

export type StreamEvent =
  | {
      kind: 'chunk';
      /** Monotonic ms when the chunk was parsed. */
      t: number;
      /** Characters of text in this chunk (content can be empty for some chunks). */
      textLen: number;
      /** Exact tokens in this chunk when the engine says so (llama.cpp tokens[], vLLM continuous usage). */
      tokens?: number;
      /** The token ids of this chunk (llama.cpp return_tokens), for the tuner's "fedeltà" comparison. */
      ids?: number[];
      /** The chunk's text, when it had some. */
      text?: string;
    }
  | { kind: 'done'; t: number; usage?: Usage; timings?: EngineTimings; finishReason?: string };

export interface GenerateRequest {
  /** Prompt as token ids (preferred: exact length, no re-tokenization drift). */
  promptIds?: number[];
  /** Prompt text, only for endpoints without token-id input (external OpenAI servers). */
  promptText?: string;
  /** Exact number of tokens to generate (ignore_eos / min_tokens). */
  outputTokens: number;
  seed: number;
  /** Model name for OpenAI-style APIs. */
  model?: string;
}

export interface InferenceClient {
  readonly flavor: ApiFlavor;
  readonly baseUrl: string;
  /** Ready check: llama.cpp /health 200, vLLM /health + model in /v1/models. */
  ready(signal?: AbortSignal): Promise<boolean>;
  tokenize(text: string, opts?: { addSpecial?: boolean; signal?: AbortSignal }): Promise<number[]>;
  /** Streams a generation; the iterable ends after the `done` event. */
  generate(req: GenerateRequest, signal?: AbortSignal): AsyncIterable<StreamEvent>;
  /** The JSON body that generate() sends for `req` (stored in the run's launch record). */
  requestBody(req: GenerateRequest): Record<string, unknown>;
  /** Model ids served (OpenAI /v1/models). */
  models(signal?: AbortSignal): Promise<string[]>;
}
