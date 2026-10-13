/**
 * Data hooks of the Server page: running servers, presets, notices, the API key, a server's plan and
 * log. Every hook reads a real core route; the core's 'servers.changed' event refreshes them
 * (useServersLiveRefresh). Custom engines come from queries-engines (useCustomEngines).
 */
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { ServerInfo, ServerPlan, StartServerRequest } from '../../contract/api';
import type { ServerApiKeyInfo, ServerLog, ServerNotice, ServerPreset, ServerPresetInput } from '../../contract/servers';
import { useI18n } from '../i18n';
import { useApi, useServerEvents } from './api-context';
import { DOCKER_CODES, useDockerNeed } from './queries-docker';
import { apiErrorData, SERVERS_KEY } from './queries-runs';

export const PRESETS_KEY = ['servers', 'presets'] as const;
export const NOTICES_KEY = ['servers', 'notices'] as const;
export const API_KEY_KEY = ['servers', 'api-key'] as const;

/** Reads servers, presets and notices again whenever the core says something changed. */
export function useServersLiveRefresh(): void {
  const qc = useQueryClient();
  useServerEvents((e) => {
    if (e.type !== 'servers.changed') return;
    void qc.invalidateQueries({ queryKey: SERVERS_KEY });
    void qc.invalidateQueries({ queryKey: PRESETS_KEY });
    void qc.invalidateQueries({ queryKey: NOTICES_KEY });
  });
}

/** GET /api/servers/presets: "I tuoi preset". */
export function useServerPresets() {
  const api = useApi();
  return useQuery({ queryKey: PRESETS_KEY, queryFn: () => api.get<ServerPreset[]>('/api/servers/presets') });
}

/** GET /api/servers/notices: starts that failed while nobody was looking. */
export function useServerNotices() {
  const api = useApi();
  return useQuery({ queryKey: NOTICES_KEY, queryFn: () => api.get<ServerNotice[]>('/api/servers/notices') });
}

/** GET /api/servers/api-key: made the first time it is asked for (only when network access is on). */
export function useServerApiKey(enabled: boolean) {
  const api = useApi();
  return useQuery({ queryKey: API_KEY_KEY, queryFn: () => api.get<ServerApiKeyInfo>('/api/servers/api-key'), enabled, staleTime: Infinity });
}

/** POST /api/servers/plan of exactly these choices: command, needs, context, fit, port. */
export function useServerPlan(request: StartServerRequest | undefined) {
  const api = useApi();
  return useQuery({
    queryKey: ['servers', 'plan', request],
    queryFn: ({ signal }) => api.post<ServerPlan>('/api/servers/plan', request, signal),
    enabled: request !== undefined,
    staleTime: 5_000,
    retry: false,
    placeholderData: keepPreviousData,
  });
}

/** GET /api/servers/:id/log while the "Log" window is open (every 2 s). */
export function useServerLog(id: string, open: boolean) {
  const api = useApi();
  return useQuery({
    queryKey: ['servers', 'log', id],
    queryFn: () => api.get<ServerLog>(`/api/servers/${encodeURIComponent(id)}/log`),
    enabled: open,
    refetchInterval: open ? 2000 : false,
    retry: false,
  });
}

/** The actions of a server card and of the presets list, with a toast either way. */
export function useServerActions() {
  const api = useApi();
  const qc = useQueryClient();
  const { t } = useI18n();
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: SERVERS_KEY });
    void qc.invalidateQueries({ queryKey: PRESETS_KEY });
    void qc.invalidateQueries({ queryKey: NOTICES_KEY });
  };
  const failed = (e: unknown) => toast.error(t(`errors.${apiErrorData(e).code}.title`));
  const [, needDocker] = useDockerNeed();
  /** Docker off or stuck: "Serve Docker" (with its button), then `again` by itself; anything else: a toast. */
  const failedOr = (e: unknown, engineLabel: string, again: () => Promise<void>) => {
    if (DOCKER_CODES.has(apiErrorData(e).code)) needDocker({ engineLabel, retry: () => void again() });
    else failed(e);
  };
  const actions = {
    stop: async (s: ServerInfo) => {
      try {
        await api.del(`/api/servers/${encodeURIComponent(s.id)}`);
        toast.success(t('servers.stopped', { name: s.presetName ?? s.modelLabel }));
      } catch (e) {
        failed(e);
      }
      refresh();
    },
    restart: async (s: ServerInfo) => {
      const name = s.presetName ?? s.modelLabel;
      toast.info(t('servers.card.restarting', { name }));
      try {
        // The new engine is listed at once (loading); this answers once it is ready again.
        const p = api.post<ServerInfo>(`/api/servers/${encodeURIComponent(s.id)}/restart`);
        setTimeout(refresh, 300);
        await p;
        toast.success(t('servers.card.restarted', { name }));
      } catch (e) {
        // The old engine is gone with Docker: once Docker answers, the same request starts it again.
        failedOr(e, s.engineLabel, () => actions.startAgain(s));
      }
      refresh();
    },
    /** The same server again (same request: port, settings, preset), after Docker came back. */
    startAgain: async (s: ServerInfo) => {
      const name = s.presetName ?? s.modelLabel;
      try {
        await api.post<ServerInfo>('/api/servers', s.request);
        toast.success(t('servers.card.restarted', { name }));
      } catch (e) {
        failed(e);
      }
      refresh();
    },
    startPreset: async (p: ServerPreset) => {
      toast.info(t('servers.presets.starting', { name: p.name }));
      try {
        const started = api.post<ServerInfo>(`/api/servers/presets/${encodeURIComponent(p.id)}/start`);
        setTimeout(refresh, 300);
        await started;
        toast.success(t('servers.presets.started', { name: p.name }));
      } catch (e) {
        failedOr(e, p.modelLabel, () => actions.startPreset(p));
      }
      refresh();
    },
    dismissNotice: async (n: ServerNotice) => {
      await api.del(`/api/servers/notices/${encodeURIComponent(n.id)}`).catch(() => undefined);
      refresh();
    },
  };
  return actions;
}

/** Save, change and remove presets. */
export function usePresetMutations() {
  const api = useApi();
  const qc = useQueryClient();
  const done = () => void qc.invalidateQueries({ queryKey: PRESETS_KEY });
  return {
    create: useMutation({ mutationFn: (input: ServerPresetInput) => api.post<ServerPreset>('/api/servers/presets', input), onSettled: done }),
    update: useMutation({ mutationFn: ({ id, patch }: { id: string; patch: Partial<Record<keyof ServerPresetInput, unknown>> }) => api.put<ServerPreset>(`/api/servers/presets/${encodeURIComponent(id)}`, patch), onSettled: done }),
    remove: useMutation({ mutationFn: (id: string) => api.del(`/api/servers/presets/${encodeURIComponent(id)}`), onSettled: done }),
  };
}

/** "Genera una nuova chiave". */
export function useRegenerateApiKey() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<ServerApiKeyInfo>('/api/servers/api-key/regenerate'),
    onSuccess: (info) => qc.setQueryData(API_KEY_KEY, info),
  });
}
