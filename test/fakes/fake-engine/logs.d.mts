export interface LlamaLogCtx {
  model: string;
  host: string;
  port: number;
  ctx: number;
  np: number;
  nLayers: number;
  vramMiB: number;
  flashAttn: string;
  kvType?: string;
  kvCapacity?: number;
}
export interface TaskTimings {
  promptN: number;
  promptMs: number;
  predictedN: number;
  predictedMs: number;
}

export function llamaBanner(c: LlamaLogCtx): string[];
export function llamaBindFailed(c: LlamaLogCtx): string[];
export function llamaListening(c: LlamaLogCtx): string[];
export function llamaModelMeta(c: LlamaLogCtx): string[];
export function llamaLoadTensorsStart(c: LlamaLogCtx): string[];
export function llamaOom(c: LlamaLogCtx): string[];
export function llamaMissingModel(c: LlamaLogCtx): string[];
export function llamaContext(c: LlamaLogCtx): string[];
export function llamaWarmup(): string[];
export function llamaReady(c: LlamaLogCtx): string[];
export function llamaTaskStart(slot: number, task: number, nPrompt: number, ctx: number): string[];
export function llamaTaskDone(slot: number, task: number, t: TaskTimings): string[];
export function llamaBadFlag(flag: string): string[];
export function llamaBadValue(flag: string): string[];
export function llamaCrash(): string[];
export function vllmBanner(c: LlamaLogCtx): string[];
export function vllmWeights(seconds: number): string[];
export function vllmModelLoaded(c: LlamaLogCtx, seconds: number): string[];
export function vllmShards(done: number, total: number): string;
export function vllmCompile(seconds: number): string[];
export function vllmKvCache(c: LlamaLogCtx & { kvTokens: number }): string[];
export function vllmGraphs(done: number, total: number): string;
export function vllmGraphsDone(seconds: number): string[];
export function vllmReady(c: LlamaLogCtx, seconds: number): string[];
export function vllmNoKernelImage(): string[];
export function vllmOom(): string[];
export function vllmKvTooSmall(c: LlamaLogCtx): string[];
export function vllmPortInUse(c: LlamaLogCtx): string[];
export function vllmVramBusy(freeMiB: number, totalMiB: number, util: number): string[];
