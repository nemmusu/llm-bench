/** The runs of a comparison, each loaded once (the same cache entries as the result page's). */
import { useQueries, type UseQueryResult } from '@tanstack/react-query';
import type { RunResult } from '../../contract/results';
import { useApi } from './api-context';

export interface RunsById {
  /** One per id, in order; undefined while loading. */
  runs: (RunResult | undefined)[];
  /** The first id that could not be loaded, and why. */
  failed?: { index: number; error: Error };
}

// Stable, so the combined result keeps its identity until a query changes.
function combine(results: UseQueryResult<RunResult>[]): RunsById {
  const index = results.findIndex((r) => r.isError);
  return { runs: results.map((r) => r.data), ...(index >= 0 ? { failed: { index, error: results[index]!.error! } } : {}) };
}

export function useRunsById(ids: readonly string[]): RunsById {
  const api = useApi();
  return useQueries({
    queries: ids.map((id) => ({
      queryKey: ['runs', 'detail', id],
      queryFn: () => api.get<RunResult>(`/api/runs/${encodeURIComponent(id)}`),
      staleTime: Infinity,
      retry: false,
    })),
    combine,
  });
}
