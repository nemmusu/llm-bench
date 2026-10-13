/** Data hooks of NInfer (contract/ninfer.ts): WSL distros, "Indica dove si trova", the guided build. */
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import type { EngineConfig, EngineStatus } from '../../contract/engines';
import { ninferKindFor, type NinferBuildPlan, type NinferBuildRequest, type NinferDistros, type NinferKind, type NinferSettings, type NinferUpdateStatus } from '../../contract/ninfer';
import type { Settings } from '../../contract/settings';
import { useApi } from './api-context';
import { libKeys, useSystemInfo } from './queries-library';
import { ENGINES_KEY } from './queries-runs';
import { SETTINGS_QUERY_KEY } from './settings';

export const ninferKeys = {
  distros: ['lib', 'ninfer', 'distros'] as const,
  plan: ['lib', 'ninfer', 'build-plan'] as const,
};

/**
 * The NInfer kind of the PC the core runs on (Linux: native, Windows: WSL): `null` where NInfer does
 * not run, undefined while the system is read.
 */
export function useNinferKind(): NinferKind | null | undefined {
  const system = useSystemInfo();
  const platform = system.data?.os.platform;
  return platform === undefined ? undefined : (ninferKindFor(platform) ?? null);
}

/** GET /api/engines/ninfer/distros: only asked when the card needs it (it reads `wsl.exe -l -v`). */
export function useNinferDistros(enabled: boolean) {
  const api = useApi();
  return useQuery({ queryKey: ninferKeys.distros, queryFn: () => api.get<NinferDistros>('/api/engines/ninfer/distros'), enabled, staleTime: 60_000 });
}

/** Every engine status shown (Engines page, Benchmark page) is read again. */
export function refreshEngines(qc: QueryClient): void {
  for (const k of [libKeys.engines, ENGINES_KEY, libKeys.check]) void qc.invalidateQueries({ queryKey: k });
}

/** POST /api/engines/ninfer/check: the status NInfer would have with this path (and distro). */
export function useNinferCheck() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (cfg: EngineConfig) => api.post<EngineStatus>('/api/engines/ninfer/check', cfg),
    onSuccess: () => refreshEngines(qc),
  });
}

/** Saves where NInfer is (settings.ninfer), then every engine status is read again with it. */
export function useSaveNinfer() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (ninfer: NinferSettings) => {
      qc.setQueryData(SETTINGS_QUERY_KEY, await api.put<Settings>('/api/settings', { ninfer }));
    },
    onSuccess: () => refreshEngines(qc),
  });
}

/** POST /api/engines/ninfer/build-plan: the commands and the prerequisites (read-only checks). */
export function useNinferBuildPlan(req: NinferBuildRequest | undefined) {
  const api = useApi();
  return useQuery({
    queryKey: [...ninferKeys.plan, req],
    queryFn: () => api.post<NinferBuildPlan>('/api/engines/ninfer/build-plan', req),
    enabled: req !== undefined,
    staleTime: 0,
    retry: false,
  });
}

/** POST /api/engines/ninfer/update-check: a git fetch in NInfer's checkout, then where it stands (on request only). */
export function useNinferUpdateCheck() {
  const api = useApi();
  return useMutation({ mutationFn: (kind: NinferKind) => api.post<NinferUpdateStatus>('/api/engines/ninfer/update-check', { kind }) });
}
