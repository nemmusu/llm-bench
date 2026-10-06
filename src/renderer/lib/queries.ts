/**
 * Data hooks for every screen. In M0 most of them resolve typed mock data; M1 swaps each
 * queryFn for the API route named in the comment, without touching the screens.
 */
import { useQuery } from '@tanstack/react-query';
import type { HealthResponse } from '../../contract/api';
import { useApi } from './api-context';
import { mockSystem } from '../mock/system';

const mock = <T>(value: T) => () => Promise.resolve(value);

/** GET /api/health (real): app version for the sidebar footer. */
export function useHealth() {
  const api = useApi();
  return useQuery({ queryKey: ['health'], queryFn: () => api.get<HealthResponse>('/api/health'), staleTime: Infinity, retry: 2 });
}

/** M1: GET /api/system */
export function useSystem() {
  return useQuery({ queryKey: ['system'], queryFn: mock(mockSystem), staleTime: Infinity });
}

// Library, engines and downloads hooks (GET /api/models/local, /api/engines, /api/downloads…) live in
// lib/queries-library.ts.

// Run hooks (GET /api/runs, /api/runs/:id…) live in lib/queries-runs.ts.
