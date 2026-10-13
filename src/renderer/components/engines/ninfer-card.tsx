import { Cpu, Hammer, RotateCcw, SquarePen } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import type { EngineConfig, EngineStatus } from '../../../contract/engines';
import { ninferPresetsFor, type NinferKind } from '../../../contract/ninfer';
import { useI18n } from '../../i18n';
import { activeEvent, useEngineStatuses, useInstallEvent } from '../../lib/queries-library';
import { useNinferCheck, useNinferDistros, useNinferKind, useSaveNinfer } from '../../lib/queries-ninfer';
import { useSettings } from '../../lib/settings';
import { ErrorCallout } from '../library/error-callout';
import { InstallProgress } from '../setup/install-progress';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Callout } from '../ui/callout';
import { Field, Input } from '../ui/input';
import { Select } from '../ui/select';
import { Skeleton } from '../ui/skeleton';
import type { StatusDotProps } from '../ui/status-dot';
import { EngineCard } from './engine-card';
import { NinferBuildDialog } from './ninfer-build-dialog';
import { EngineUpdatePanel } from './engine-update';
import { NinferArtifacts } from './ninfer-artifacts';
import { presetTitle } from './ninfer-format';

type Tone = StatusDotProps['tone'];

/** The card's status line from the engine status. */
export function ninferStatus(status: EngineStatus | undefined, t: ReturnType<typeof useI18n>['t']): { tone: Tone; text: string } {
  if (!status) return { tone: 'neutral', text: t('common.loading') };
  if (!status.supported) return { tone: 'neutral', text: t('ninfer.status.unsupported') };
  if (status.problems.includes('ENGINE_GPU_UNSUPPORTED')) return { tone: 'danger', text: t('ninfer.status.gpu') };
  if (status.available) return { tone: 'success', text: t('ninfer.status.ready') };
  if (status.problemParams?.reason === 'not_configured') return { tone: 'neutral', text: t('ninfer.status.notConfigured') };
  return { tone: 'warning', text: t('ninfer.status.notFound') };
}

/**
 * NInfer: where its build is (Linux, or a WSL distro and the path inside it), checked by running
 * its help; the guided build; the built-in settings it offers for .ninfer models.
 */
export function NinferCard() {
  const { t } = useI18n();
  const kind = useNinferKind();
  const engines = useEngineStatuses();
  const status = engines.data?.find((e) => e.kind === kind);
  return (
    <EngineCard
      icon={<Cpu />}
      title={t('ninfer.title')}
      description={t('ninfer.desc')}
      badge={
        <Badge tone="outline" size="sm">
          {t('ninfer.badge')}
        </Badge>
      }
      status={engines.isPending || kind === undefined ? { tone: 'neutral', text: t('common.loading') } : ninferStatus(status, t)}
    >
      {kind === undefined ? (
        <Skeleton className="h-24" />
      ) : kind === null || status?.supported === false ? (
        <p className="text-sm text-fg-2">{t('ninfer.unsupportedBody')}</p>
      ) : (
        <NinferSetup kind={kind} status={status} />
      )}
    </EngineCard>
  );
}

function NinferSetup({ kind, status }: { kind: NinferKind; status: EngineStatus | undefined }) {
  const { t } = useI18n();
  const { settings } = useSettings();
  const save = useSaveNinfer();
  const wsl = kind === 'ninfer-wsl';
  const savedPath = wsl ? settings.ninfer?.wsl?.path : settings.ninfer?.native?.path;
  const savedDistro = wsl ? settings.ninfer?.wsl?.distro : undefined;
  const distros = useNinferDistros(wsl);
  const list = distros.data?.distros ?? [];
  const [distro, setDistro] = useState<string | undefined>(undefined);
  const chosenDistro = distro ?? savedDistro ?? list.find((d) => d.default)?.name ?? list[0]?.name;
  const [path, setPath] = useState(savedPath ?? '');
  const [editing, setEditing] = useState(false);
  const [build, setBuild] = useState(false);
  const check = useNinferCheck();
  const event = useInstallEvent(kind);
  const running = activeEvent(event);
  const configured = savedPath !== undefined && !editing;

  const cfgOf = (p: string): EngineConfig => ({ kind, ninferPath: p, ...(wsl && chosenDistro ? { wslDistro: chosenDistro } : {}) });
  const use = () => {
    const p = path.trim();
    if (!p) return;
    check.mutate(cfgOf(p), {
      onSuccess: (s) => {
        if (!s.installed) return;
        save.mutate({ ...settings.ninfer, ...(wsl ? { wsl: { distro: chosenDistro as string, path: p } } : { native: { path: p } }) });
        setEditing(false);
        toast.success(t('ninfer.where.saved'));
      },
    });
  };
  const recheck = () => savedPath !== undefined && check.mutate({ kind, ninferPath: savedPath, ...(savedDistro ? { wslDistro: savedDistro } : {}) });
  // The check's own answer (a path not saved yet), else the saved build's status.
  const shown = check.data ?? status;
  const presets = ninferPresetsFor({ name: 'qwen3.8-27b' });

  return (
    <div className="flex flex-col gap-4">
      {shown?.problems.includes('ENGINE_GPU_UNSUPPORTED') && <Callout tone="danger" title={t('ninfer.gpuOnly')} />}
      {wsl && distros.data?.wsl === false && <Callout tone="warning" title={t('ninfer.distro.noWslTitle')}>{t('ninfer.distro.noWsl')}</Callout>}
      {configured ? (
        <div className="flex flex-col gap-2 rounded-lg border border-border bg-surface-2 p-3">
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-sm">
            <dt className="text-fg-3">{t('ninfer.found.path')}</dt>
            <dd className="font-mono text-xs break-all text-fg">{status?.location ?? savedPath}</dd>
            {savedDistro && (
              <>
                <dt className="text-fg-3">{t('ninfer.found.distro')}</dt>
                <dd className="text-fg">{savedDistro}</dd>
              </>
            )}
            {status?.version && (
              <>
                <dt className="text-fg-3">{t('ninfer.found.commit')}</dt>
                <dd className="font-mono text-xs text-fg">{status.version}</dd>
              </>
            )}
          </dl>
          {shown && !shown.installed && <NinferProblem status={shown} fallback={savedPath} />}
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={recheck} disabled={check.isPending}>
              <RotateCcw aria-hidden />
              {t('ninfer.where.recheck')}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>
              <SquarePen aria-hidden />
              {t('ninfer.where.change')}
            </Button>
          </div>
          <div className="border-t border-border pt-3">
            <EngineUpdatePanel
              target={kind}
              name={t(`benchmark.engines.${kind}`)}
              enabled={status?.installed === true}
              extra={(c) => <NinferArtifacts check={c} where={wsl ? t('ninfer.build.whereWsl', { distro: savedDistro ?? '' }) : t('ninfer.build.whereLinux')} />}
            />
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {wsl && (
            <Field label={t('ninfer.distro.label')} hint={t('ninfer.distro.hint')}>
              {({ id, describedBy }) =>
                distros.isPending ? (
                  <Skeleton className="h-9" />
                ) : (
                  <Select<string>
                    id={id}
                    aria-describedby={describedBy}
                    value={chosenDistro ?? ''}
                    onValueChange={setDistro}
                    options={list.map((d) => ({
                      value: d.name,
                      label: d.name,
                      text: d.name,
                      ...(d.default ? { description: t('ninfer.distro.default') } : {}),
                      ...(d.version === 1 ? { description: t('ninfer.distro.wsl1'), disabled: true } : {}),
                    }))}
                  />
                )
              }
            </Field>
          )}
          <Field label={t('ninfer.where.label')} hint={t('ninfer.where.hint')}>
            {({ id, describedBy }) => (
              <div className="flex gap-2">
                <Input id={id} aria-describedby={describedBy} value={path} onChange={(e) => setPath(e.target.value)} placeholder={t('ninfer.where.placeholder')} className="min-w-0 flex-1 font-mono" spellCheck={false} />
                <Button variant="primary" className="shrink-0" onClick={use} disabled={check.isPending || !path.trim() || (wsl && !chosenDistro)}>
                  {check.isPending ? t('ninfer.where.checking') : t('ninfer.where.check')}
                </Button>
              </div>
            )}
          </Field>
          {check.data && !check.data.installed && (
            <NinferProblem status={check.data} fallback={path} />
          )}
        </div>
      )}
      {check.isError && <ErrorCallout error={check.error} />}
      {save.isError && <ErrorCallout error={save.error} />}
      {running ? (
        <InstallProgress event={running} label={t('ninfer.build.running')} />
      ) : (
        <Button size="sm" variant="secondary" className="self-start" onClick={() => setBuild(true)} disabled={wsl && !chosenDistro}>
          <Hammer aria-hidden />
          {t('ninfer.build.open')}
        </Button>
      )}
      <section className="flex flex-col gap-1.5" aria-label={t('ninfer.presets.cardTitle')}>
        <h3 className="text-sm font-semibold text-fg">{t('ninfer.presets.cardTitle')}</h3>
        <ul className="flex flex-col gap-1 text-sm text-fg-2">
          {presets.map((p) => (
            <li key={p.id}>{presetTitle(p, t)}</li>
          ))}
        </ul>
        <p className="text-xs text-fg-3">{t('ninfer.presets.cardHint')}</p>
      </section>
      {wsl && <p className="text-xs text-fg-3">{t('ninfer.wslModels', { distro: chosenDistro ?? 'Ubuntu' })}</p>}
      <NinferBuildDialog open={build} onOpenChange={setBuild} kind={kind} distro={chosenDistro} />
    </div>
  );
}

const KNOWN_PROBLEMS = ['ninfer_not_found', 'distro_missing', 'wsl_missing'] as const;
type KnownProblem = (typeof KNOWN_PROBLEMS)[number];

/** Why NInfer cannot be used, in its own words (a wrong path, a distro that is gone), else the error catalog's. */
export function NinferProblem({ status, fallback }: { status: EngineStatus; fallback?: string | undefined }) {
  const { t } = useI18n();
  const reason = status.problemParams?.reason;
  if (typeof reason === 'string' && (KNOWN_PROBLEMS as readonly string[]).includes(reason)) {
    const r = reason as KnownProblem;
    const params = { path: String(status.problemParams?.path ?? status.location ?? fallback ?? ''), distro: String(status.problemParams?.distro ?? '') };
    return (
      <Callout tone="danger" title={t(`ninfer.problems.${r}.title`, params)}>
        {t(`ninfer.problems.${r}.body`, params)}
      </Callout>
    );
  }
  return <ErrorCallout error={{ code: status.problems[0] ?? 'ENGINE_NOT_INSTALLED', message: status.location ?? fallback ?? '', ...(status.problemParams ? { params: status.problemParams } : {}) }} />;
}
