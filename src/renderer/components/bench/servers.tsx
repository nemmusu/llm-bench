/** "Avvia solo il server così": start dialog, and the "Server attivi" panel with the addresses and Stop. */
import { useQueryClient } from '@tanstack/react-query';
import { Copy, Globe, Loader, Server, Square } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import type { ServerInfo, StartServerRequest } from '../../../contract/api';
import type { AppErrorData } from '../../../contract/errors';
import { useI18n } from '../../i18n';
import { useApi } from '../../lib/api-context';
import { apiErrorData, SERVERS_KEY, useServers } from '../../lib/queries-runs';
import { Button, IconButton } from '../ui/button';
import { Card, CardHeader, CardTitle } from '../ui/card';
import { Dialog, DialogContent } from '../ui/dialog';
import { HelpTip } from '../ui/help-tip';
import { ErrorCard } from './error-card';

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

function useStopServer() {
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

/** Running servers, with their address for other programs and a Stop button. Hidden when there are none. */
export function ServersPanel() {
  const { t, relative } = useI18n();
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
              </span>
              <Button size="sm" variant="danger-outline" onClick={() => void stop(s)} aria-label={t('servers.stopNamed', { name: s.modelName })}>
                <Square aria-hidden />
                {t('servers.stop')}
              </Button>
            </div>
            <Address url={s.openaiUrl} label={t('servers.copyUrl')} />
          </li>
        ))}
      </ul>
    </Card>
  );
}

type ServeState = { step: 'confirm' } | { step: 'starting' } | { step: 'ready'; info: ServerInfo } | { step: 'error'; error: AppErrorData };

/** Starts the engine with a run's exact settings and shows where other programs can reach it. */
export function ServeDialog({ open, onOpenChange, request }: { open: boolean; onOpenChange: (open: boolean) => void; request: StartServerRequest }) {
  const { t } = useI18n();
  const api = useApi();
  const qc = useQueryClient();
  const stop = useStopServer();
  const [state, setState] = useState<ServeState>({ step: 'confirm' });

  const start = async () => {
    setState({ step: 'starting' });
    try {
      const info = await api.post<ServerInfo>('/api/servers', request);
      setState({ step: 'ready', info });
    } catch (e) {
      setState({ step: 'error', error: apiErrorData(e) });
    }
    await qc.invalidateQueries({ queryKey: SERVERS_KEY });
  };

  // Opened by the caller; Radix only ever asks to close (Escape, overlay, the close button).
  const close = () => {
    setState({ step: 'confirm' });
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent
        title={t('result.launch.serveTitle')}
        description={state.step === 'ready' ? t('servers.readyBody') : t('result.launch.serveBody')}
        footer={
          state.step === 'ready' ? (
            <>
              <Button
                variant="danger-outline"
                onClick={() => {
                  void stop(state.info).then(close);
                }}
              >
                <Square aria-hidden />
                {t('servers.stop')}
              </Button>
              <Button variant="primary" onClick={close}>
                {t('servers.keepRunning')}
              </Button>
            </>
          ) : (
            <>
              <Button onClick={close}>{t('common.cancel')}</Button>
              <Button variant="primary" disabled={state.step === 'starting'} onClick={() => void start()}>
                {state.step === 'starting' ? <Loader aria-hidden className="animate-spin" /> : <Server aria-hidden />}
                {state.step === 'error' ? t('common.retry') : t('result.launch.serveStart')}
              </Button>
            </>
          )
        }
      >
        {state.step === 'ready' ? (
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-1">
              <span className="text-xs font-medium text-fg-3">{t('servers.openaiUrl')}</span>
              <Address url={state.info.openaiUrl} label={t('servers.copyUrl')} />
            </div>
            <div className="flex flex-col gap-1">
              <span className="text-xs font-medium text-fg-3">{t('servers.baseUrl')}</span>
              <Address url={state.info.baseUrl} label={t('servers.copyBaseUrl')} />
            </div>
            <p className="text-xs text-fg-3">{t('servers.modelName', { name: state.info.modelName })}</p>
          </div>
        ) : state.step === 'error' ? (
          <ErrorCard error={state.error} headingLevel={3} />
        ) : state.step === 'starting' ? (
          <p className="flex items-center gap-2 text-sm text-fg-2" aria-live="polite">
            <Loader aria-hidden className="size-4 animate-spin text-accent" />
            {t('servers.starting')}
          </p>
        ) : (
          <p className="text-sm text-fg-2">{t('servers.confirmHint')}</p>
        )}
      </DialogContent>
    </Dialog>
  );
}
