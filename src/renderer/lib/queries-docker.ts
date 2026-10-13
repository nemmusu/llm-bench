/**
 * Docker for every screen: its state (a real check before a start), "Avvia Docker", "Riavvia Docker"
 * (the last resort too), why it got stuck and how to avoid it, and our servers it took down
 * ("Riavvia i server che erano attivi"). Progress arrives as 'engine.install' events, kept by
 * queries-library (keys 'docker-desktop' and 'docker-restart').
 */
import { skipToken, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { DockerDiagnosis, DockerRecovery } from '../../contract/docker';
import type { DockerStatusDetail } from '../../contract/views';
import { useApi } from './api-context';
import { libKeys, useInstallEvent, useStartInstall } from './queries-library';

export const dockerKeys = {
  probe: [...libKeys.docker, 'probe'] as const,
  diagnosis: [...libKeys.docker, 'diagnosis'] as const,
  recovery: [...libKeys.docker, 'recovery'] as const,
};

/** Install-event keys of a start and a restart (also the system check's). */
export const DOCKER_START_KEY = 'docker-desktop';
export const DOCKER_RESTART_KEY = 'docker-restart';

/** States in which Docker can be used (no GPU still runs containers; the run will say what is wrong). */
export const DOCKER_READY: ReadonlySet<DockerStatusDetail['state']> = new Set(['running', 'no-gpu']);

/** Failures "Serve Docker" fixes: Docker off, or up but not answering. */
export const DOCKER_CODES: ReadonlySet<string> = new Set(['DOCKER_NOT_RUNNING', 'DOCKER_NOT_RESPONDING']);

/** Something the user asked for needs Docker first; `retry` does it again once Docker answers. */
export interface DockerNeed {
  /** What needs Docker ("vLLM (Docker)"); absent: Docker itself. */
  engineLabel?: string;
  retry: () => void;
}

const NEED_KEY = ['ui', 'docker-need'] as const;

/** The pending "Serve Docker" (DockerAlerts shows it in a dialog), and a way to ask for one or drop it. */
export function useDockerNeed(): [DockerNeed | undefined, (need: DockerNeed | undefined) => void] {
  const qc = useQueryClient();
  const { data } = useQuery<DockerNeed | null>({ queryKey: NEED_KEY, queryFn: skipToken, initialData: null, staleTime: Infinity });
  return [data ?? undefined, (need) => qc.setQueryData(NEED_KEY, need ?? null)];
}

/**
 * A real check (the engine itself is asked, not only Docker Desktop's cache), for a screen about to
 * use Docker; asked again every `pollStartingMs` while Docker is starting.
 */
export function useDockerProbe(enabled = true, pollStartingMs?: number) {
  const api = useApi();
  return useQuery({
    queryKey: dockerKeys.probe,
    queryFn: () => api.get<DockerStatusDetail>('/api/docker/status?probe=1'),
    enabled,
    staleTime: 0,
    gcTime: 0,
    retry: false,
    refetchInterval: (q) => (pollStartingMs !== undefined && q.state.data?.state === 'starting' ? pollStartingMs : false),
  });
}

/** Why Docker got stuck and Resource Saver's setting (read from Docker Desktop, never changed). */
export function useDockerDiagnosis(enabled: boolean) {
  const api = useApi();
  return useQuery({ queryKey: dockerKeys.diagnosis, queryFn: () => api.get<DockerDiagnosis>('/api/docker/diagnosis'), enabled, staleTime: 30_000, retry: false });
}

/** Our servers Docker took down. */
export function useDockerRecovery() {
  const api = useApi();
  return useQuery({ queryKey: dockerKeys.recovery, queryFn: () => api.get<DockerRecovery>('/api/docker/recovery') });
}

/**
 * Start, restart (deep: the last resort, after the user's click), open Docker Desktop, start our lost
 * servers again or forget them; with the latest progress of a start and of a restart.
 */
export function useDockerActions() {
  const api = useApi();
  const qc = useQueryClient();
  const install = useStartInstall();
  const startEvent = useInstallEvent(DOCKER_START_KEY);
  const restartEvent = useInstallEvent(DOCKER_RESTART_KEY);
  const open = useMutation({ mutationFn: () => api.post<{ ok: true }>('/api/docker/open') });
  const forget = useMutation({
    mutationFn: () => api.del('/api/docker/recovery'),
    onSettled: () => void qc.invalidateQueries({ queryKey: dockerKeys.recovery }),
  });
  return {
    startEvent,
    restartEvent,
    start: () => install.mutate({ key: DOCKER_START_KEY, path: '/api/docker/start' }),
    restart: (deep = false) => install.mutate({ key: DOCKER_RESTART_KEY, path: '/api/docker/restart', body: { deep } }),
    restore: () => install.mutate({ key: DOCKER_RESTART_KEY, path: '/api/docker/recovery' }),
    open,
    forget,
  };
}
