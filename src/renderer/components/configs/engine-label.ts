import type { ConfigEntry } from '../../../contract/configs';
import { isDockerKind } from '../../../contract/engines';
import { prettyEngineLabel } from '../bench/format';

/** "llama.cpp b11438 (CUDA 13.4)", "vLLM v0.12.0 (CUDA) · Docker", "SGLang v0.5.2 · Docker". */
export function configEngineLabel(e: Pick<ConfigEntry, 'engineLabel' | 'engineKind'>): string {
  return prettyEngineLabel(e.engineLabel) + (isDockerKind(e.engineKind) ? ' · Docker' : '');
}
