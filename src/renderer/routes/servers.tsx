/**
 * The Server page: the servers that are on (address, snippets, Ferma / Riavvia / Log), the saved
 * presets (start with one click, "Avvia all'apertura di GPU Bench") and the starts that failed while
 * nobody was looking. "Avvia un server" opens the start flow.
 */
import { Link } from '@tanstack/react-router';
import { Plus, Server, Square } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import type { ServerInfo } from '../../contract/api';
import type { ServerPreset } from '../../contract/servers';
import { PresetsList } from '../components/servers/presets-list';
import { SavePresetDialog } from '../components/servers/save-preset-dialog';
import { ServerCard, useNow } from '../components/servers/server-card';
import { useOpenServerFlow } from '../components/servers/use-open-flow';
import { Page } from '../components/shell/page';
import { Button } from '../components/ui/button';
import { Callout } from '../components/ui/callout';
import { Card } from '../components/ui/card';
import { HelpTip } from '../components/ui/help-tip';
import { Skeleton } from '../components/ui/skeleton';
import { useI18n } from '../i18n';
import { useServers } from '../lib/queries-runs';
import { useCustomEngines } from '../lib/queries-engines';
import { usePresetMutations, useServerActions, useServerNotices, useServerPresets, useServersLiveRefresh } from '../lib/queries-servers';

function SectionTitle({ title, help, count }: { title: string; help: string; count?: number }) {
  return (
    <h2 className="flex items-center gap-2 text-lg font-semibold tracking-[-0.01em] text-fg">
      {title}
      {count !== undefined && count > 0 && <span className="rounded-full bg-surface-3 px-2 text-sm font-medium text-fg-2 tabular-nums">{count}</span>}
      <HelpTip term={title}>{help}</HelpTip>
    </h2>
  );
}

export function ServersPage() {
  const { t } = useI18n();
  useServersLiveRefresh();
  const servers = useServers();
  const presets = useServerPresets();
  const notices = useServerNotices();
  const customList = useCustomEngines().data ?? [];
  const actions = useServerActions();
  const { create } = usePresetMutations();
  const openFlow = useOpenServerFlow();
  const now = useNow(30_000);
  const [saving, setSaving] = useState<ServerInfo | undefined>(undefined);
  const list = servers.data ?? [];
  const running = new Set(list.map((s) => s.presetId).filter((id): id is string => id !== undefined));

  const savePreset = async (name: string, autoStart: boolean) => {
    const s = saving!;
    const { presetId: _p, ...req } = s.request;
    const saved = await create.mutateAsync({
      name,
      engine: req.engine,
      model: req.model,
      modelLabel: s.modelLabel,
      params: s.params,
      port: s.port,
      network: s.network,
      autoStart,
      source: { kind: 'custom' },
      ...(req.recipe ? { recipe: req.recipe } : {}),
    });
    toast.success(t('servers.presets.saved', { name: saved.name }));
    setSaving(undefined);
  };

  const edit = (p: ServerPreset) => openFlow({ presetId: p.id, engine: p.engine, model: p.model, params: p.params });

  return (
    <Page
      title={t('servers.title')}
      subtitle={t('servers.subtitle')}
      width="wide"
      actions={
        <Button variant="primary" asChild>
          <Link to="/servers/new">
            <Plus aria-hidden />
            {t('servers.start')}
          </Link>
        </Button>
      }
    >
      <div className="flex flex-col gap-section">
        {(notices.data ?? []).map((n) => (
          <Callout key={n.id} tone="danger" title={t(`servers.notices.${n.kind}`, { name: n.name })} action={{ label: t('servers.notices.dismiss'), onClick: () => void actions.dismissNotice(n) }}>
            {t(`errors.${n.error.code}.title`)}. {t(`errors.${n.error.code}.what`)}
          </Callout>
        ))}

        <section aria-labelledby="servers-running" className="flex flex-col gap-3">
          <div id="servers-running" className="flex flex-wrap items-center justify-between gap-2">
            <SectionTitle title={t('servers.running.title')} help={t('servers.running.help')} count={list.length} />
            {list.length > 1 && (
              <Button size="sm" variant="danger-outline" onClick={() => list.forEach((s) => void actions.stop(s))}>
                <Square aria-hidden />
                {t('servers.running.stopAll')}
              </Button>
            )}
          </div>
          {servers.isPending ? (
            <Skeleton className="h-48" />
          ) : list.length ? (
            <div className="grid gap-4 2xl:grid-cols-2">
              {list.map((s) => (
                <ServerCard key={s.id} server={s} customs={customList} now={now} onStop={(x) => void actions.stop(x)} onRestart={(x) => void actions.restart(x)} onSave={setSaving} />
              ))}
            </div>
          ) : (
            <Card className="flex flex-col items-center gap-3 px-6 py-10 text-center">
              <span aria-hidden className="grid size-12 place-items-center rounded-full bg-accent-soft text-accent-text">
                <Server className="size-6" />
              </span>
              <h3 className="text-md font-semibold text-fg">{t('servers.running.noneTitle')}</h3>
              <p className="max-w-lg text-sm text-fg-2">{t('servers.running.noneBody')}</p>
              <Button variant="primary" asChild>
                <Link to="/servers/new">
                  <Plus aria-hidden />
                  {t('servers.start')}
                </Link>
              </Button>
            </Card>
          )}
        </section>

        <section aria-labelledby="servers-presets" className="flex flex-col gap-3">
          <div id="servers-presets">
            <SectionTitle title={t('servers.presets.title')} help={t('servers.presets.help')} count={presets.data?.length} />
          </div>
          <Card>
            {presets.isPending ? (
              <Skeleton className="m-card h-20" />
            ) : presets.data?.length ? (
              <PresetsList presets={presets.data} running={running} customs={customList} onStart={(p) => void actions.startPreset(p)} onEdit={edit} />
            ) : (
              <div className="flex flex-col gap-1 px-card py-6">
                <p className="text-sm font-medium text-fg">{t('servers.presets.noneTitle')}</p>
                <p className="text-sm text-fg-2">{t('servers.presets.noneBody')}</p>
              </div>
            )}
          </Card>
        </section>
      </div>
      {saving && <SavePresetDialog port={saving.port} defaultName={saving.modelLabel} onClose={() => setSaving(undefined)} onSave={savePreset} />}
    </Page>
  );
}
