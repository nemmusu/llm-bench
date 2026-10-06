/** Engine choice ⇄ EngineConfig (custom executable, Docker image, external endpoint…). */
import type { ApiFlavor, EngineConfig, EngineKind } from '../../../contract/engines';

export interface EngineForm {
  executable: string;
  image: string;
  vllmPath: string;
  baseUrl: string;
  apiKey: string;
  flavor: ApiFlavor;
  /** external: model name to send in requests. */
  modelName: string;
}

export type EngineField = keyof EngineForm;

export const EMPTY_ENGINE_FORM: EngineForm = { executable: '', image: '', vllmPath: '', baseUrl: '', apiKey: '', flavor: 'openai', modelName: '' };

export const ENGINE_ORDER: readonly EngineKind[] = ['llamacpp-native', 'llamacpp-docker', 'vllm-docker', 'vllm-native', 'external'];

export function isHttpUrl(text: string): boolean {
  try {
    const u = new URL(text);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * The engine part of the request. Outside expert mode only the kind is sent (GPU Bench picks the
 * managed build / default image). An external endpoint needs a valid URL.
 */
export function engineConfigOf(kind: EngineKind, form: EngineForm, expert: boolean): { config: EngineConfig; invalid: EngineField[] } {
  const config: EngineConfig = { kind };
  const invalid: EngineField[] = [];
  if (kind === 'external') {
    const url = form.baseUrl.trim();
    if (!isHttpUrl(url)) invalid.push('baseUrl');
    else config.baseUrl = url;
    if (form.apiKey.trim()) config.apiKey = form.apiKey.trim();
    config.flavor = form.flavor;
    return { config, invalid };
  }
  if (!expert) return { config, invalid };
  if (kind === 'llamacpp-native' && form.executable.trim()) config.executable = form.executable.trim();
  if ((kind === 'llamacpp-docker' || kind === 'vllm-docker') && form.image.trim()) config.image = form.image.trim();
  if (kind === 'vllm-native' && form.vllmPath.trim()) config.vllmPath = form.vllmPath.trim();
  return { config, invalid };
}

/** Restores the form from a saved config (the API key is never saved). */
export function engineFormOf(config: EngineConfig | undefined): EngineForm {
  return {
    ...EMPTY_ENGINE_FORM,
    executable: config?.executable ?? '',
    image: config?.image ?? '',
    vllmPath: config?.vllmPath ?? '',
    baseUrl: config?.baseUrl ?? '',
    flavor: config?.flavor ?? 'openai',
  };
}

/** What settings.lastEngine keeps: everything but the secret. */
export function savableEngine(config: EngineConfig): EngineConfig {
  const { apiKey: _secret, ...rest } = config;
  return rest;
}
