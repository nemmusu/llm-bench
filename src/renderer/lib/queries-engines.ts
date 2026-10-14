/**
 * Data hooks of "Motori personalizzati" and SGLang (Motori page, Benchmark engine choice). Saving
 * an engine changes settings.customEngines: the settings query is refreshed with the list.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CustomEngine, CustomEngineCheck, CustomEngineDraft, CustomEngineInfo, CustomEngineRemovePlan } from '../../contract/custom-engines';
import type { EngineUpdateCheck } from '../../contract/engine-updates';
import type { Settings } from '../../contract/settings';
import { useApi } from './api-context';
import type { VllmTag } from './queries-library';
import { SETTINGS_QUERY_KEY } from './settings';

export const engineKeys = {
  custom: ['engines', 'custom'] as const,
  sglangTags: ['engines', 'sglang', 'tags'] as const,
  updates: ['engines', 'update'] as const,
  update: (target: string) => ['engines', 'update', target] as const,
};

/** The update API of a target ('sglang-docker', 'custom:<id>'…). */
export function updatePath(target: string): string {
  return target.startsWith('custom:') ? `/api/engines/custom/${encodeURIComponent(target.slice('custom:'.length))}/update` : `/api/engines/${target}/update`;
}

/** Is there a newer version? Cheap: no git fetch, Docker Hub and PyPI answers cached by the core. */
export function useEngineUpdate(target: string, enabled: boolean) {
  const api = useApi();
  return useQuery({ queryKey: engineKeys.update(target), queryFn: () => api.get<EngineUpdateCheck>(updatePath(target)), enabled, staleTime: 10 * 60_000, retry: false });
}

/** "Controlla aggiornamenti": the remote asked again (git fetch, Docker Hub, PyPI). */
export function useRecheckUpdate(target: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.get<EngineUpdateCheck>(`${updatePath(target)}?fetch=1`),
    onSuccess: (check) => qc.setQueryData(engineKeys.update(target), check),
  });
}

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
    onSuccess: (saved) => refresh(qc, (list) => (list.some((e) => e.id === saved.id) ? list.map((e) => (e.id === saved.id ? saved : e)) : [...list, saved])),
  });
}

export function useDuplicateCustomEngine() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) => api.post<CustomEngine>(`/api/engines/custom/${encodeURIComponent(id)}/duplicate`, { name }),
    onSuccess: (copy) => refresh(qc, (list) => [...list, copy]),
  });
}

/** What deleting an engine can remove besides forgetting it (the files LLM Bench added for it), asked when its dialog opens. */
export function useCustomEngineRemovePlan(id: string, enabled: boolean) {
  const api = useApi();
  return useQuery({
    queryKey: ['engines', 'custom-remove', id],
    queryFn: () => api.get<CustomEngineRemovePlan>(`/api/engines/custom/${encodeURIComponent(id)}/remove`),
    enabled,
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });
}

/** Forgets an engine; with `files`, removes the files LLM Bench added for it first. */
export function useDeleteCustomEngine() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, files }: { id: string; files?: boolean }) => api.del<{ ok: true }>(`/api/engines/custom/${encodeURIComponent(id)}${files ? '?files=1' : ''}`),
    onSuccess: (_ok, { id }) => refresh(qc, (list) => list.filter((e) => e.id !== id)),
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

/**
 * The cached settings get the same change at once (the Benchmark's engine choice reads them), and the
 * list with its checks is read again. The settings are not re-read: a re-read still in flight would
 * bring back the values from before a settings save made right now ("Usa nel Benchmark").
 */
function refresh(qc: ReturnType<typeof useQueryClient>, change: (list: CustomEngine[]) => CustomEngine[]): void {
  qc.setQueryData<Settings>(SETTINGS_QUERY_KEY, (old) => (old ? { ...old, customEngines: change(old.customEngines) } : old));
  void qc.invalidateQueries({ queryKey: engineKeys.custom });
}
