import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CircleCheck, FileCog, ListTree, RefreshCw, RotateCcw, Server, Trash2 } from 'lucide-react';
import { useState } from 'react';
import type { InstalledBuild } from '../../../contract/views';
import { useI18n } from '../../i18n';
import { useApi } from '../../lib/api-context';
import { activeEvent, libKeys, useEngineStatuses, useInstallEvent, useInstalledBuilds, useLlamaReleases, useSaveEngine, useStartInstall } from '../../lib/queries-library';
import { useSettings } from '../../lib/settings';
import { ErrorCallout } from '../library/error-callout';
import { InstallProgress } from '../setup/install-progress';
import { LLAMA_KEY, LlamaInstall } from '../setup/llama-install';
import { Badge } from '../ui/badge';
import { Button, IconButton } from '../ui/button';
import { Callout } from '../ui/callout';
import { ConfirmDialog, Dialog, DialogContent } from '../ui/dialog';
import { PathText } from '../ui/path-text';
import { Skeleton } from '../ui/skeleton';
import { EngineCard } from './engine-card';

function ReleasesDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { t, date } = useI18n();
  const releases = useLlamaReleases(open);
  const start = useStartInstall();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title={t('engines.llama.releasesTitle')} description={t('engines.llama.releasesHint')} size="md">
        {releases.isError && <ErrorCallout error={releases.error} />}
        {releases.isPending && <Skeleton className="h-40" />}
        <ul className="flex flex-col divide-y divide-border" aria-label={t('engines.llama.releasesTitle')}>
          {(releases.data ?? []).slice(0, 20).map((r) => (
            <li key={r.tag} className="flex items-center justify-between gap-3 py-2.5">
              <span className="flex flex-col">
                <span className="font-mono text-sm font-semibold text-fg">{r.tag}</span>
                <span className="text-xs text-fg-3">{date(r.publishedAt)}</span>
              </span>
              <Button
                size="sm"
                onClick={() => {
                  start.mutate({ key: LLAMA_KEY, path: '/api/engines/llamacpp-native/install', body: { build: r.tag } });
                  onOpenChange(false);
                }}
              >
                {t('engines.llama.installThis', { tag: r.tag })}
              </Button>
            </li>
          ))}
        </ul>
      </DialogContent>
    </Dialog>
  );
}

/**
 * "Aggiorna" for the builds LLM Bench installed, like every other engine: the newest release against the
 * build in use ("Aggiornamento disponibile: b10997 → b11438"), one click to install it (the old build
 * stays, removable from the list), with its progress here.
 */
export function LlamaUpdate({ current, installed, pinned, onUse }: { current: string | undefined; installed: readonly string[]; pinned: boolean; onUse: (tag: string) => void }) {
  const { t } = useI18n();
  const releases = useLlamaReleases(true);
  const start = useStartInstall();
  const event = useInstallEvent(LLAMA_KEY);
  const running = activeEvent(event);
  const save = useSaveEngine();
  if (running) return <InstallProgress event={running} label={t('engines.update.progress', { name: t('engines.kinds.llamacpp-native') })} className="w-full" />;
  const latest = releases.data?.[0]?.tag;
  const check = (
    <Button size="sm" variant="ghost" className="self-start" disabled={releases.isFetching} onClick={() => void releases.refetch()}>
      <RefreshCw aria-hidden />
      {releases.isFetching ? t('engines.update.checking') : t('engines.update.check')}
    </Button>
  );
  const failed = event?.stage === 'error' && <ErrorCallout error={event.error ?? { code: 'ENGINE_INSTALL_FAILED', message: 'error' }} />;
  let body;
  if (releases.isError) {
    body = (
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-xs text-fg-3">{t('engines.update.checkFailed')}</p>
        {check}
      </div>
    );
  } else if (!latest || !current) {
    body = null;
  } else if (latest === current) {
    body = (
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="flex items-center gap-1.5 text-sm text-fg-2">
          <CircleCheck aria-hidden className="size-4 text-success-text" />
          {t('engines.update.current', { current })}
        </p>
        {check}
      </div>
    );
  } else if (installed.includes(latest)) {
    // The newest is already here, another one is chosen: using it is the update.
    body = <Callout tone="info" title={t('engines.llama.newerInstalled', { current, latest })} action={{ label: t('engines.llama.useTag', { tag: latest }), onClick: () => onUse(latest) }} />;
  } else {
    body = (
      <Callout
        tone="info"
        title={t('engines.update.available', { current, latest })}
        action={{
          label: t('engines.update.update'),
          onClick: () => {
            // A build chosen by hand would stay in use: the update means "the newest" again.
            if (pinned) save.mutate({ kind: 'llamacpp-native' });
            start.mutate({ key: LLAMA_KEY, path: '/api/engines/llamacpp-native/install', body: { build: latest } });
          },
        }}
      />
    );
  }
  return (
    <div className="flex flex-col gap-2">
      {body}
      {failed}
    </div>
  );
}

/** llama.cpp: managed builds (install, pick, remove) or the user's own llama-server. */
export function LlamaCard({ installBytes }: { installBytes?: number | undefined }) {
  const { t, dateTime } = useI18n();
  const api = useApi();
  const qc = useQueryClient();
  const { settings } = useSettings();
  const save = useSaveEngine();
  const engines = useEngineStatuses();
  const builds = useInstalledBuilds();
  const [releases, setReleases] = useState(false);
  const [remove, setRemove] = useState<InstalledBuild>();
  const del = useMutation({
    mutationFn: (id: string) => api.del(`/api/engines/llamacpp/installed/${encodeURIComponent(id)}`),
    onSuccess: () => {
      for (const k of [libKeys.builds, libKeys.engines, libKeys.check]) void qc.invalidateQueries({ queryKey: k });
    },
  });
  const status = engines.data?.find((e) => e.kind === 'llamacpp-native');
  const last = settings.lastEngine?.kind === 'llamacpp-native' ? settings.lastEngine : undefined;
  const custom = last?.executable;
  const list = builds.data ?? [];
  const inUse = (b: InstalledBuild, i: number) => !custom && (last?.build ? last.build === b.tag || last.build === b.id : i === 0);

  const selectBuild = (b?: InstalledBuild) => save.mutate({ kind: 'llamacpp-native', ...(b ? { build: b.tag } : {}) });
  const pickExe = async () => {
    const bridge = window.gpubench;
    const exe = await bridge?.pickFile({
      title: t('engines.llama.customTitle'),
      ...(bridge?.platform === 'win32' ? { filters: [{ name: 'llama-server', extensions: ['exe'] }] } : {}),
    });
    // GET /api/engines detects llama.cpp with the saved executable: that is the validation.
    if (exe) save.mutate({ kind: 'llamacpp-native', executable: exe });
  };

  const tone = status?.available ? ('success' as const) : status?.installed ? ('warning' as const) : ('danger' as const);
  const text = status?.available ? t('engines.status.ready') : status?.installed ? t('engines.status.broken') : t('engines.status.notInstalled');

  return (
    <EngineCard
      icon={<Server />}
      title={t('engines.kinds.llamacpp-native')}
      description={t('engines.desc.llamacpp-native')}
      badge={
        <Badge tone="accent" size="sm">
          {t('common.recommended')}
        </Badge>
      }
      status={engines.isPending ? { tone: 'neutral', text: t('common.loading') } : { tone, text }}
      footer={
        <>
          {list.length === 0 && <LlamaInstall bytes={installBytes} />}
          <Button size="sm" variant="ghost" onClick={() => setReleases(true)}>
            <ListTree aria-hidden />
            {t('engines.llama.chooseRelease')}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => void pickExe()}>
            <FileCog aria-hidden />
            {t('engines.actions.customExe')}
          </Button>
        </>
      }
    >
      {custom && (
        <div className="flex flex-col gap-2 rounded-lg border border-border bg-surface-2 p-3">
          <p className="text-xs font-medium text-fg-3">{t('engines.llama.customInUse')}</p>
          <p className="font-mono text-xs text-fg">
            <PathText path={custom} />
          </p>
          {status?.available ? (
            <p className="text-sm text-success-text">{t('engines.llama.customOk', { version: status.version ?? '–' })}</p>
          ) : (
            status && (
              <ErrorCallout
                error={{ code: status.problems[0] ?? 'ENGINE_START_FAILED', message: status.location ?? custom, ...(status.problemParams ? { params: status.problemParams } : {}) }}
              />
            )
          )}
          <Button size="sm" className="self-start" onClick={() => selectBuild()}>
            <RotateCcw aria-hidden />
            {t('engines.llama.backToManaged')}
          </Button>
        </div>
      )}
      {builds.isError && <ErrorCallout error={builds.error} />}
      {list.length > 0 && (
        <ul className="flex flex-col divide-y divide-border rounded-lg border border-border" aria-label={t('engines.llama.installed')}>
          {list.map((b, i) => (
            <li key={b.id} className="flex flex-wrap items-center gap-3 px-3 py-2.5">
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="flex items-center gap-2">
                  <span className="font-mono text-sm font-semibold text-fg">{b.tag}</span>
                  <Badge size="sm" tone="outline">
                    {b.cudaVersion ? `CUDA ${b.cudaVersion}` : b.variant}
                  </Badge>
                  {inUse(b, i) && (
                    <Badge size="sm" tone="success">
                      {t('engines.llama.inUse')}
                    </Badge>
                  )}
                </span>
                <span className="text-xs text-fg-3">{t('engines.llama.installedAt', { when: dateTime(b.installedAt) })}</span>
              </span>
              {!inUse(b, i) && (
                <Button size="sm" onClick={() => selectBuild(b)}>
                  {t('engines.llama.use')}
                </Button>
              )}
              <IconButton label={t('engines.llama.remove', { tag: b.tag })} icon={<Trash2 />} size="sm" onClick={() => setRemove(b)} />
            </li>
          ))}
        </ul>
      )}
      {list.length > 0 && !custom && (
        <LlamaUpdate current={list.find(inUse)?.tag} installed={list.map((b) => b.tag)} pinned={last?.build !== undefined} onUse={(tag) => save.mutate({ kind: 'llamacpp-native', build: tag })} />
      )}
      {del.isError && <ErrorCallout error={del.error} />}
      {save.isError && <ErrorCallout error={save.error} />}
      <ReleasesDialog open={releases} onOpenChange={setReleases} />
      <ConfirmDialog
        open={remove !== undefined}
        onOpenChange={(o) => !o && setRemove(undefined)}
        title={t('engines.llama.removeTitle', { tag: remove?.tag ?? '' })}
        description={t('engines.llama.removeBody')}
        confirmLabel={t('engines.llama.removeConfirm')}
        cancelLabel={t('common.cancel')}
        onConfirm={() => del.mutate((remove as InstalledBuild).id)}
      />
    </EngineCard>
  );
}
