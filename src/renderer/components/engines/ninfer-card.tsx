import { Cpu } from 'lucide-react';
import { useCallback } from 'react';
import { ninferPresetsFor, type NinferBuildId, type NinferBuildInfo, type NinferKind } from '../../../contract/ninfer';
import { useI18n } from '../../i18n';
import { useNinferBuilds, useNinferDistro, useNinferDistros, useNinferKind, useRecheckBuilds } from '../../lib/queries-ninfer';
import { useSettings } from '../../lib/settings';
import { ErrorCallout } from '../library/error-callout';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Callout } from '../ui/callout';
import { Skeleton } from '../ui/skeleton';
import type { StatusDotProps } from '../ui/status-dot';
import { EngineCard } from './engine-card';
import { NinferBuildRow } from './ninfer-build-row';
import { presetTitle } from './ninfer-format';

export { NinferProblem } from './ninfer-problem';

type Tone = StatusDotProps['tone'];

/** The card's status: ready when either build answers (the GPU first), else whether anything is set up at all. */
export function cardStatus(builds: readonly NinferBuildInfo[], t: ReturnType<typeof useI18n>['t']): { tone: Tone; text: string } {
  if (builds.some((b) => b.status?.problems.includes('ENGINE_GPU_UNSUPPORTED'))) return { tone: 'danger', text: t('ninfer.status.gpu') };
  if (builds.some((b) => b.state === 'ready' || b.state === 'stale')) return { tone: 'success', text: t('ninfer.status.ready') };
  if (builds.every((b) => b.state === 'missing')) return { tone: 'neutral', text: t('ninfer.status.notConfigured') };
  return { tone: 'warning', text: t('ninfer.status.notFound') };
}

export interface NinferCardProps {
  /** /engines?ninfer=all: this build drawn out and scrolled to (a model that needs it sent the user here). */
  focus?: NinferBuildId | undefined;
  /** That model's name. */
  forModel?: string | undefined;
}

/**
 * NInfer and its two builds, each with its state and the one thing to do (NinferBuildRow): the official
 * one, and NInfer-all for the GGUF-NInfer models; the built-in settings it offers for .ninfer models.
 */
export function NinferCard({ focus, forModel }: NinferCardProps) {
  const { t } = useI18n();
  const kind = useNinferKind();
  const builds = useNinferBuilds(typeof kind === 'string');
  const list = builds.data?.builds ?? [];
  const status = kind === null ? { tone: 'neutral' as const, text: t('ninfer.status.unsupported') } : builds.data ? cardStatus(list, t) : { tone: 'neutral' as const, text: t('common.loading') };
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
      status={status}
    >
      {kind === null ? (
        <p className="text-sm text-fg-2">{t('ninfer.unsupportedBody')}</p>
      ) : kind === undefined || builds.isPending ? (
        <Skeleton className="h-24" />
      ) : builds.isError ? (
        <ErrorCallout error={builds.error} action={{ label: t('common.retry'), onClick: () => void builds.refetch() }} />
      ) : (
        <NinferBuilds kind={kind} builds={list} focus={focus} forModel={forModel} />
      )}
    </EngineCard>
  );
}

function NinferBuilds({ kind, builds, focus, forModel }: { kind: NinferKind; builds: NinferBuildInfo[]; focus?: NinferBuildId | undefined; forModel?: string | undefined }) {
  const { t } = useI18n();
  const { settings } = useSettings();
  const wsl = kind === 'ninfer-wsl';
  const distros = useNinferDistros(wsl);
  const distro = useNinferDistro(kind, settings.ninfer?.wsl?.distro);
  const recheck = useRecheckBuilds();
  const presets = ninferPresetsFor({ name: 'qwen3.8-27b' });
  const noWsl = wsl && distros.data?.wsl === false;
  // The build a model sent the user to, scrolled into view once it is on the page.
  const focused = useCallback((el: HTMLDivElement | null) => el?.scrollIntoView({ block: 'center' }), []);
  return (
    <div className="flex flex-col gap-4">
      {builds.some((b) => b.status?.problems.includes('ENGINE_GPU_UNSUPPORTED')) && <Callout tone="danger" title={t('ninfer.gpuOnly')} />}
      {noWsl && <Callout tone="warning" title={t('ninfer.distro.noWslTitle')}>{t('ninfer.distro.noWsl')}</Callout>}
      {builds.map((b) => (
        <div key={b.build} ref={b.build === focus ? focused : undefined}>
          <NinferBuildRow info={b} kind={kind} distro={distro} highlight={b.build === focus} forModel={forModel} />
        </div>
      ))}
      <Button size="sm" variant="ghost" className="self-start" onClick={() => recheck.mutate()} disabled={recheck.isPending}>
        {recheck.isPending ? t('ninfer.where.checking') : t('ninfer.where.recheck')}
      </Button>
      <section className="flex flex-col gap-1.5" aria-label={t('ninfer.presets.cardTitle')}>
        <h3 className="text-sm font-semibold text-fg">{t('ninfer.presets.cardTitle')}</h3>
        <ul className="flex flex-col gap-1 text-sm text-fg-2">
          {presets.map((p) => (
            <li key={p.id}>{presetTitle(p, t)}</li>
          ))}
        </ul>
        <p className="text-xs text-fg-3">{t('ninfer.presets.cardHint')}</p>
      </section>
      {wsl && <p className="text-xs text-fg-3">{t('ninfer.wslModels', { distro: distro ?? 'Ubuntu' })}</p>}
    </div>
  );
}
