/** Risultati → Configurazioni: GET /api/configs (under the 'runs' key, so a changed results folder refreshes it). */
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type { ConfigsQuery, ConfigsResponse } from '../../contract/configs';
import { useApi } from './api-context';
import { RUNS_KEY } from './queries-runs';

export const CONFIGS_KEY = [...RUNS_KEY, 'configs'] as const;

/** "?gpu=…&minContext=…" with only the filters that are set. */
export function configsSearch(q: ConfigsQuery): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) if (v !== undefined) params.set(k, String(v));
  const s = params.toString();
  return s ? `?${s}` : '';
}

/** The configurations matching `query`; the previous list stays on screen while a new filter loads. */
export function useConfigs(query: ConfigsQuery) {
  const api = useApi();
  return useQuery({
    queryKey: [...CONFIGS_KEY, query],
    queryFn: () => api.get<ConfigsResponse>(`/api/configs${configsSearch(query)}`),
    placeholderData: keepPreviousData,
  });
}
