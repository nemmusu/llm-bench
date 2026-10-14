/** Data hooks of NInfer (contract/ninfer.ts): WSL distros, its two builds, "Cambia cartella", the guided build. */
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import {
  ninferKindFor,
  type NinferBuildId,
  type NinferBuildInfo,
  type NinferBuildPath,
  type NinferBuildPathResult,
  type NinferBuildPlan,
  type NinferBuildRequest,
  type NinferBuilds,
  type NinferDistros,
  type NinferKind,
} from '../../contract/ninfer';
import { useApi } from './api-context';
import { engineKeys } from './queries-engines';
import { libKeys, useSystemInfo } from './queries-library';
import { ENGINES_KEY } from './queries-runs';
import { SETTINGS_QUERY_KEY } from './settings';

export const ninferKeys = {
  distros: ['lib', 'ninfer', 'distros'] as const,
  plan: ['lib', 'ninfer', 'build-plan'] as const,
  builds: libKeys.ninferBuilds,
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

/** The distro NInfer runs in: the official build's, else the default one (WSL only). */
export function useNinferDistro(kind: NinferKind | null | undefined, saved: string | undefined): string | undefined {
  const distros = useNinferDistros(kind === 'ninfer-wsl');
  if (kind !== 'ninfer-wsl') return undefined;
  const list = distros.data?.distros ?? [];
  return saved ?? (list.find((d) => d.default) ?? list[0])?.name;
}

/** Every engine status shown (Engines page, Benchmark page) and NInfer's builds are read again. */
export function refreshEngines(qc: QueryClient): void {
  for (const k of [libKeys.engines, ENGINES_KEY, libKeys.check, ninferKeys.builds]) void qc.invalidateQueries({ queryKey: k });
}

/** After a build or a "Cambia cartella": the settings, the custom engines (NInfer-all is one), every status. */
export function refreshAfterBuild(qc: QueryClient): void {
  void qc.invalidateQueries({ queryKey: SETTINGS_QUERY_KEY });
  void qc.invalidateQueries({ queryKey: engineKeys.custom });
  void qc.invalidateQueries({ queryKey: engineKeys.updates });
  refreshEngines(qc);
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

/** GET /api/engines/ninfer/builds: the official build and NInfer-all, each with its state. */
export function useNinferBuilds(enabled = true) {
  const api = useApi();
  return useQuery({ queryKey: ninferKeys.builds, queryFn: () => api.get<NinferBuilds>('/api/engines/ninfer/builds'), enabled, staleTime: 30_000 });
}

/** One of the two builds (undefined while they are read, or where NInfer does not run). */
export function useNinferBuild(build: NinferBuildId, enabled = true): NinferBuildInfo | undefined {
  return useNinferBuilds(enabled).data?.builds.find((b) => b.build === build);
}

/** "Ricontrolla": both builds probed again (not the probe the core trusts for a few minutes). */
export function useRecheckBuilds() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.get<NinferBuilds>('/api/engines/ninfer/builds?fresh=1'),
    onSuccess: (builds) => {
      qc.setQueryData(ninferKeys.builds, builds);
      for (const k of [libKeys.engines, ENGINES_KEY, engineKeys.custom]) void qc.invalidateQueries({ queryKey: k });
    },
  });
}

/** "Cambia cartella": a build of the user's own, saved only when it answers. */
export function useSetBuildPath(build: NinferBuildId) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: NinferBuildPath) => api.put<NinferBuildPathResult>(`/api/engines/ninfer/builds/${build}`, body),
    onSuccess: (r) => {
      if (r.saved) refreshAfterBuild(qc);
    },
  });
}
