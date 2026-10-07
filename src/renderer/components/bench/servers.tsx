/** Servers started from GPU Bench: the "Server attivi" panel, their addresses, Stop. */
import { useQueryClient } from '@tanstack/react-query';
import { Copy, Globe, Server, Square } from 'lucide-react';
import { toast } from 'sonner';
import type { ServerInfo } from '../../../contract/api';
import { useI18n } from '../../i18n';
import { useApi } from '../../lib/api-context';
import { apiErrorData, SERVERS_KEY, useServers } from '../../lib/queries-runs';
import { Button, IconButton } from '../ui/button';
import { Card, CardHeader, CardTitle } from '../ui/card';
import { HelpTip } from '../ui/help-tip';
import { engineKindOfLabel } from './live-now';
import { LoadLine } from './load-line';

export async function copyText(text: string, done: string, failed: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(done);
  } catch {
    toast.error(failed);
  }
}

function Address({ url, label }: { url: string; label: string }) {
  const { t } = useI18n();
  return (
    <div className="flex items-center gap-2 rounded-md border border-border bg-surface-2 py-1 pr-1 pl-3">
      <Globe aria-hidden className="size-4 shrink-0 text-fg-3" />
      <code className="min-w-0 flex-1 truncate font-mono text-xs text-fg" title={url}>
        {url}
      </code>
      <IconButton size="sm" label={label} icon={<Copy />} onClick={() => void copyText(url, t('common.copied'), t('common.copyFailed'))} />
    </div>
  );
}

/** DELETE /api/servers/:id with a toast either way, then the list is read again. */
export function useStopServer() {
  const api = useApi();
  const qc = useQueryClient();
  const { t } = useI18n();
  return async (s: ServerInfo) => {
    try {
      await api.del(`/api/servers/${encodeURIComponent(s.id)}`);
      toast.success(t('servers.stopped', { name: s.modelName }));
    } catch (e) {
      toast.error(t(`errors.${apiErrorData(e).code}.title`));
    }
    await qc.invalidateQueries({ queryKey: SERVERS_KEY });
  };
}

/** A server that just got ready: where other programs reach it, with copy buttons. */
export function ServerReady({ info }: { info: ServerInfo }) {
  const { t, integer } = useI18n();
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <span className="text-xs font-medium text-fg-3">{t('servers.openaiUrl')}</span>
        <Address url={info.openaiUrl} label={t('servers.copyUrl')} />
      </div>
      <div className="flex flex-col gap-1">
        <span className="text-xs font-medium text-fg-3">{t('servers.baseUrl')}</span>
        <Address url={info.baseUrl} label={t('servers.copyBaseUrl')} />
      </div>
      <p className="text-xs text-fg-3">
        {t('servers.modelName', { name: info.modelName })}
        {info.contextSize !== undefined && ` · ${t('servers.context', { n: integer(info.contextSize) })}`}
      </p>
    </div>
  );
}

/** Running servers, with their address for other programs and a Stop button. Hidden when there are none. */
export function ServersPanel() {
  const { t, relative, integer } = useI18n();
  const servers = useServers();
  const stop = useStopServer();
  const list = servers.data ?? [];
  if (!list.length) return null;
  return (
    <Card>
      <CardHeader className="items-center">
        <CardTitle className="flex items-center gap-1.5">
          <Server aria-hidden className="size-4 text-accent-text" />
          {t('servers.title')}
          <HelpTip term={t('servers.title')}>{t('servers.help')}</HelpTip>
        </CardTitle>
      </CardHeader>
      <ul className="flex flex-col gap-3 px-card pt-3 pb-card">
        {list.map((s) => (
          <li key={s.id} className="flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-sm font-medium text-fg">{s.modelName}</span>
                <span className="truncate text-xs text-fg-3">
                  {s.engineLabel} · {t('servers.since', { time: relative(s.startedAt) })}
                </span>
                {s.contextSize !== undefined && <span className="truncate text-xs text-fg-3">{t('servers.context', { n: integer(s.contextSize) })}</span>}
              </span>
              <Button size="sm" variant="danger-outline" onClick={() => void stop(s)} aria-label={t('servers.stopNamed', { name: s.modelName })}>
                <Square aria-hidden />
                {t('servers.stop')}
              </Button>
            </div>
            {s.loading ? <LoadLine progress={s.loading} engineKind={engineKindOfLabel(s.engineLabel)} /> : <Address url={s.openaiUrl} label={t('servers.copyUrl')} />}
          </li>
        ))}
      </ul>
    </Card>
  );
}
