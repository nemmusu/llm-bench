/**
 * App-wide data hooks. Feature hooks live next to their screens: lib/queries-library.ts (system,
 * setup, models, engines, downloads) and lib/queries-runs.ts (runs, plans, servers).
 */
import { useQuery } from '@tanstack/react-query';
import type { HealthResponse } from '../../contract/api';
import { useApi } from './api-context';

/** GET /api/health: app version for the sidebar footer. */
export function useHealth() {
  const api = useApi();
  return useQuery({ queryKey: ['health'], queryFn: () => api.get<HealthResponse>('/api/health'), staleTime: Infinity, retry: 2 });
}
