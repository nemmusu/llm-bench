import type { ConfigEntry } from '../../../contract/configs';
import type { EngineKind } from '../../../contract/engines';
import { prettyEngineLabel } from '../bench/format';

const DOCKER: ReadonlySet<EngineKind> = new Set<EngineKind>(['llamacpp-docker', 'vllm-docker']);

/** "llama.cpp b11438 (CUDA 13.4)", "vLLM v0.12.0 (CUDA) · Docker". */
export function configEngineLabel(e: Pick<ConfigEntry, 'engineLabel' | 'engineKind'>): string {
  return prettyEngineLabel(e.engineLabel) + (DOCKER.has(e.engineKind) ? ' · Docker' : '');
}
