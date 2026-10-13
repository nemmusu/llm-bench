/**
 * Data hooks of the benchmark flow (Benchmark, live run, results, compare). Every hook reads a
 * real core route; keys live under 'bench' (or 'runs') so they never share a cache entry with
 * the setup/library screens' hooks, which may shape the same routes differently.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import type { ActiveRunResponse, RunPlan, ServerInfo, StartRunRequest, SystemResponse } from '../../contract/api';
import type { EngineKind, EngineStatus, LaunchParams } from '../../contract/engines';
import type { FitEstimate, LocalModel } from '../../contract/models';
import type { RunResult, RunSummary } from '../../contract/results';
import type { CuratedResponse } from '../../contract/views';
import { ApiError } from './api';
import { useApi, useServerEvents } from './api-context';

export const RUNS_KEY = ['runs'] as const;
export const SERVERS_KEY = ['bench', 'servers'] as const;
export const LOCAL_MODELS_KEY = ['bench', 'models', 'local'] as const;
export const ENGINES_KEY = ['bench', 'engines'] as const;

/** GET /api/runs: every saved run, newest first. */
export function useRuns() {
  const api = useApi();
  return useQuery({ queryKey: RUNS_KEY, queryFn: () => api.get<RunSummary[]>('/api/runs') });
}

/** GET /api/runs/:id. A missing run is an ApiError RUN_NOT_FOUND (never retried). */
export function useRun(id: string | undefined) {
  const api = useApi();
  return useQuery({
    queryKey: ['runs', 'detail', id],
    queryFn: () => api.get<RunResult>(`/api/runs/${encodeURIComponent(id!)}`),
    enabled: id !== undefined,
    staleTime: Infinity,
    retry: false,
  });
}

/**
 * GET /api/runs/active: the run in progress with its start time, ETA, labels and scenario, polled
 * while the live screen is open (it rebuilds the screen after a reload, and catches a missed SSE event).
 */
export function useActiveRun(pollMs: number | false = false) {
  const api = useApi();
  return useQuery({
    queryKey: ['runs', 'active'],
    queryFn: () => api.get<ActiveRunResponse>('/api/runs/active'),
    refetchInterval: pollMs,
    staleTime: 0,
    gcTime: 0,
  });
}

/**
 * The sidebar's copy of the active run: its own cache key, so it never changes the query the live
 * screen decides on (a run that is starting would otherwise look over before it exists). Polled
 * because the card must follow a run from any page.
 */
export function useShellActiveRun() {
  const api = useApi();
  return useQuery({
    queryKey: ['shell', 'active-run'],
    queryFn: () => api.get<ActiveRunResponse>('/api/runs/active'),
    refetchInterval: 5000,
    staleTime: 0,
  });
}

/** GET /api/runs/tried: past results of one model, this PC + GPU first. */
export function useTried(model: { weakKey: string; sha256?: string } | undefined) {
  const api = useApi();
  return useQuery({
    queryKey: ['runs', 'tried', model?.weakKey, model?.sha256],
    queryFn: () => {
      const q = new URLSearchParams({ weakKey: model!.weakKey, ...(model!.sha256 ? { sha256: model!.sha256 } : {}) });
      return api.get<RunSummary[]>(`/api/runs/tried?${q.toString()}`);
    },
    enabled: model !== undefined,
  });
}

/** Refetches the run lists whenever the core says the results folder changed. */
export function useRunsLiveRefresh(): void {
  const qc = useQueryClient();
  useServerEvents((e) => {
    if (e.type === 'runs.changed') void qc.invalidateQueries({ queryKey: RUNS_KEY });
  });
}

/** GET /api/system (GPU, host, paths). */
export function useBenchSystem() {
  const api = useApi();
  return useQuery({ queryKey: ['bench', 'system'], queryFn: () => api.get<SystemResponse>('/api/system'), staleTime: 30_000 });
}

/** GET /api/engines: what is installed and usable. */
export function useBenchEngines() {
  const api = useApi();
  return useQuery({ queryKey: ENGINES_KEY, queryFn: () => api.get<EngineStatus[]>('/api/engines'), staleTime: 30_000 });
}

/** GET /api/models/local. */
export function useBenchLocalModels() {
  const api = useApi();
  return useQuery({ queryKey: LOCAL_MODELS_KEY, queryFn: () => api.get<LocalModel[]>('/api/models/local'), staleTime: 30_000 });
}

/** GET /api/models/curated?vramGB=: recommendations for this card (the core snaps the VRAM to its tier). */
export function useCurated(vramGB: number | undefined) {
  const api = useApi();
  return useQuery({
    queryKey: ['bench', 'curated', vramGB],
    queryFn: () => api.get<CuratedResponse>(`/api/models/curated?vramGB=${vramGB!}`),
    enabled: vramGB !== undefined,
    staleTime: Infinity,
  });
}

/** POST /api/models/fit for a local model with the current engine and parameters. */
export function useLocalFit(localId: string | undefined, engine: EngineKind, params: LaunchParams | undefined) {
  const api = useApi();
  return useQuery({
    queryKey: ['bench', 'fit', localId, engine, params],
    queryFn: () => api.post<FitEstimate>('/api/models/fit', { localId, engine, ...(params ? { params } : {}) }),
    enabled: localId !== undefined && engine !== 'external',
    staleTime: 30_000,
    retry: false,
  });
}

/** `value`, updated only after it stopped changing for `ms`. */
export function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return debounced;
}

/** POST /api/runs/plan (debounced by the caller): the exact command, needs, duration and warnings. */
export function usePlan(request: StartRunRequest | undefined) {
  const api = useApi();
  return useQuery({
    queryKey: ['bench', 'plan', request],
    queryFn: ({ signal }) => api.post<RunPlan>('/api/runs/plan', request, signal),
    enabled: request !== undefined,
    staleTime: 10_000,
    retry: false,
    placeholderData: (prev) => prev,
  });
}

/** GET /api/servers: engines started with "Avvia solo il server così". */
export function useServers(pollMs?: number) {
  const api = useApi();
  return useQuery({
    queryKey: SERVERS_KEY,
    queryFn: () => api.get<ServerInfo[]>('/api/servers'),
    staleTime: 5_000,
    // A server still starting: follow its loading line.
    refetchInterval: (q) => pollMs ?? (q.state.data?.some((s) => s.loading) ? 1000 : false),
  });
}

/** The core's error, or a generic INTERNAL one for anything else. */
export function apiErrorData(e: unknown): ApiError['data'] {
  return e instanceof ApiError ? e.data : { code: 'INTERNAL', message: e instanceof Error ? e.message : String(e) };
}
