/**
 * Data hooks for every screen. In M0 most of them resolve typed mock data; M1 swaps each
 * queryFn for the API route named in the comment, without touching the screens.
 */
import { useQuery } from '@tanstack/react-query';
import type { HealthResponse } from '../../contract/api';
import { useApi } from './api-context';
import { mockDownloads, mockLocalModels, mockRecommended } from '../mock/models';
import { getMockRun, mockRunSummaries } from '../mock/runs';
import { mockEngines, mockSystem } from '../mock/system';

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

/** M1: GET /api/engines */
export function useEngines() {
  return useQuery({ queryKey: ['engines'], queryFn: mock(mockEngines), staleTime: Infinity });
}

/** M2: GET /api/models/local */
export function useLocalModels() {
  return useQuery({ queryKey: ['models', 'local'], queryFn: mock(mockLocalModels), staleTime: Infinity });
}

/** M2: curated list + POST /api/models/fit + GET /api/runs/tried */
export function useRecommendedModels() {
  return useQuery({ queryKey: ['models', 'recommended'], queryFn: mock(mockRecommended), staleTime: Infinity });
}

/** M2: GET /api/downloads (+ download.update events) */
export function useDownloads() {
  return useQuery({ queryKey: ['downloads'], queryFn: mock(mockDownloads), staleTime: Infinity });
}

/** M1: GET /api/runs */
export function useRuns() {
  return useQuery({ queryKey: ['runs'], queryFn: mock(mockRunSummaries), staleTime: Infinity });
}

/** M1: GET /api/runs/:id */
export function useRun(id: string) {
  return useQuery({ queryKey: ['runs', id], queryFn: () => Promise.resolve(getMockRun(id)), staleTime: Infinity });
}
