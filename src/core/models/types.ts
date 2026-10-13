import type { ModelFacts } from '../../contract/models';

/** Layers that share one attention shape (same KV heads, head sizes and window). */
export interface AttentionGroup {
  layers: number;
  kvHeads: number;
  keyLength: number;
  valueLength: number;
  /** Sliding-window size in tokens; undefined = full attention. */
  window?: number;
}

/**
 * Exact per-layer KV layout read from GGUF metadata or config.json. The contract's scalar
 * ModelFacts cannot describe models whose layers differ (Gemma 4: 16 KV heads × 256 on SWA
 * layers but 4 × 512 on global ones; Qwen3.5: 3 of 4 layers are recurrent), so the fit
 * estimator prefers this when present.
 */
export interface KvLayout {
  groups: AttentionGroup[];
  /** Layers that keep a recurrent (SSM / linear-attention) state instead of, or next to, a KV cache. */
  recurrentLayers: number;
  /** Bytes of recurrent state per sequence, summed over all recurrent layers (f32). */
  recurrentBytesPerSeq: number;
}

/** ModelFacts plus what the VRAM estimator needs beyond the contract. Serializable as JSON. */
export interface ModelFactsEx extends ModelFacts {
  kv?: KvLayout;
  vocabSize?: number;
  feedForwardLength?: number;
  /**
   * Share of the GGUF file llama.cpp keeps in RAM: the input token embeddings, when the model has
   * a separate output.weight (with tied embeddings the same tensor is also uploaded as output).
   */
  cpuOnlyFraction?: number;
  /** A GGUF holding only an MTP / NextN head (speculative-decoding add-on), not a model of its own. */
  mtpOnly?: boolean;
}

/** GPU memory as the fit estimator sees it. */
export interface GpuMem {
  totalMiB: number;
  /** Free right now: total minus what every process holds. */
  freeMiB: number;
  /** Of what is in use, what GPU Bench's own engines hold (a server it started): not "other programs". */
  ownMiB?: number;
}

export type GpuInfoFn = () => Promise<GpuMem | undefined>;
/** Returns the HF token if the user saved one. Never log its value. */
export type TokenFn = () => string | undefined;
