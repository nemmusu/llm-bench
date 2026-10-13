/** One readiness check; true = ready. Errors (connection refused while starting) mean "not yet". */
export type ReadyProbe = (signal: AbortSignal) => Promise<boolean>;

const PROBE_TIMEOUT_MS = 5000;

/** `data[].id` (OpenAI) or `models[].name|model` (llama.cpp) of a /v1/models body. */
export function listsModel(body: string, name: string): boolean {
  try {
    const j = JSON.parse(body) as { data?: { id?: unknown }[]; models?: { name?: unknown; model?: unknown }[] };
    const ids = [...(j.data ?? []).map((m) => m.id), ...(j.models ?? []).flatMap((m) => [m.name, m.model])];
    return ids.includes(name);
  } catch {
    return false;
  }
}

/**
 * Ready = /health 200 and /v1/models lists `name` (our marker: llama.cpp --alias, vLLM
 * --served-model-name). llama-server answers /health 503 while loading; vLLM binds only once
 * loaded but must also list the model. The name check makes sure a 200 from somebody else's
 * server that grabbed the port never counts as ours.
 */
export function modelReadyProbe(fetchFn: typeof globalThis.fetch, baseUrl: string, name: string, apiKey?: string): ReadyProbe {
  return async (signal) => {
    const s = AbortSignal.any([signal, AbortSignal.timeout(PROBE_TIMEOUT_MS)]);
    const health = await fetchFn(`${baseUrl}/health`, { signal: s });
    await health.text();
    if (health.status !== 200) return false;
    // A server shared on the network answers /v1/models only with its key.
    const models = await fetchFn(`${baseUrl}/v1/models`, { signal: s, ...(apiKey ? { headers: { authorization: `Bearer ${apiKey}` } } : {}) });
    const body = await models.text();
    return models.ok && listsModel(body, name);
  };
}
