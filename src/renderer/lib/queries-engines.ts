/**
 * Data hooks of "Motori personalizzati" and SGLang (Motori page, Benchmark engine choice). Saving
 * an engine changes settings.customEngines: the settings query is refreshed with the list.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CustomEngine, CustomEngineCheck, CustomEngineDraft, CustomEngineInfo } from '../../contract/custom-engines';
import { useApi } from './api-context';
import type { VllmTag } from './queries-library';
import { SETTINGS_QUERY_KEY } from './settings';

export const engineKeys = {
  custom: ['engines', 'custom'] as const,
  sglangTags: ['engines', 'sglang', 'tags'] as const,
};

/** GET /api/engines/custom: every saved engine, its kind and its check (runs, version, flags it lacks). */
export function useCustomEngines() {
  const api = useApi();
  return useQuery({ queryKey: engineKeys.custom, queryFn: () => api.get<CustomEngineInfo[]>('/api/engines/custom') });
}

/** Create (no id) or update (id) an engine; the list and the settings are refreshed. */
export function useSaveCustomEngine() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, draft }: { id?: string | undefined; draft: CustomEngineDraft }) =>
      id === undefined ? api.post<CustomEngine>('/api/engines/custom', draft) : api.put<CustomEngine>(`/api/engines/custom/${encodeURIComponent(id)}`, draft),
    onSuccess: () => refresh(qc),
  });
}

export function useDuplicateCustomEngine() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) => api.post<CustomEngine>(`/api/engines/custom/${encodeURIComponent(id)}/duplicate`, { name }),
    onSuccess: () => refresh(qc),
  });
}

export function useDeleteCustomEngine() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.del<{ ok: true }>(`/api/engines/custom/${encodeURIComponent(id)}`),
    onSuccess: () => refresh(qc),
  });
}

/** "Prova": --version / --help of an engine not saved yet. */
export function useCheckCustomEngine() {
  const api = useApi();
  return useMutation({ mutationFn: (draft: CustomEngineDraft) => api.post<CustomEngineCheck>('/api/engines/custom/check', draft) });
}

/** GET /api/engines/sglang/tags: lmsysorg/sglang releases, the recommended one marked. */
export function useSglangTags(enabled: boolean) {
  const api = useApi();
  return useQuery({ queryKey: engineKeys.sglangTags, queryFn: () => api.get<VllmTag[]>('/api/engines/sglang/tags'), enabled, staleTime: 10 * 60_000, retry: false });
}

function refresh(qc: ReturnType<typeof useQueryClient>): void {
  void qc.invalidateQueries({ queryKey: engineKeys.custom });
  void qc.invalidateQueries({ queryKey: SETTINGS_QUERY_KEY });
}
