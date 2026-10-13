import { useNavigate } from '@tanstack/react-router';
import { Box, Check, Cpu, Download, ExternalLink, FolderOpen, HardDrive, Layers, Minus, MonitorCog, Play, RefreshCw, RotateCcw, Server, TriangleAlert, X } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { CheckActionKind, CheckId, CheckItem, CheckState, SystemCheckReport } from '../../../contract/views';
import { useI18n, type Formatters } from '../../i18n';
import { cn } from '../../lib/cn';
import { activeEvent, useInstallEvent, useRecheck, useStartInstall, useSystemCheck } from '../../lib/queries-library';
import { prettyVariant } from '../bench/format';
import { ErrorCallout } from '../library/error-callout';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Callout } from '../ui/callout';
import { Skeleton } from '../ui/skeleton';
import { DockerInstallDialog } from './docker-install-dialog';
import { InstallProgress } from './install-progress';

const ICONS: Record<CheckId, ReactNode> = {
  driver: <MonitorCog />,
  gpu: <Cpu />,
  llamacpp: <Server />,
  models: <Layers />,
  disk: <HardDrive />,
  docker: <Box />,
  'vllm-native': <Box />,
};

/** Which 'engine.install' kind reports the progress of each one-click fix. */
export const INSTALL_KEYS: Partial<Record<CheckActionKind, string>> = {
  'install-llamacpp': 'llamacpp-native',
  'start-docker': 'docker-desktop',
  'restart-docker': 'docker-restart',
  'install-docker': 'docker-desktop',
  'install-docker-linux': 'docker-linux',
  'install-uv': 'uv',
  'install-vllm': 'vllm-native',
};

const START_PATHS: Partial<Record<CheckActionKind, string>> = {
  'install-llamacpp': '/api/engines/llamacpp-native/install',
  'start-docker': '/api/docker/start',
  'restart-docker': '/api/docker/restart',
  'install-docker': '/api/setup/docker/install',
  'install-docker-linux': '/api/setup/docker/install',
  'install-uv': '/api/setup/uv/install',
  'install-vllm': '/api/engines/vllm-native/install',
};

function CheckIcon({ state }: { state: CheckState }) {
  const looks: Record<CheckState, [string, ReactNode]> = {
    ok: ['bg-success-soft text-success-text', <Check key="i" strokeWidth={2.75} />],
    missing: ['bg-danger-soft text-danger-text', <X key="i" strokeWidth={2.75} />],
    warning: ['bg-warning-soft text-warning-text', <TriangleAlert key="i" strokeWidth={2.5} />],
    optional: ['bg-surface-3 text-fg-3', <Minus key="i" strokeWidth={2.75} />],
    unsupported: ['bg-surface-3 text-fg-3', <Minus key="i" strokeWidth={2.75} />],
  };
  const [cls, icon] = looks[state];
  return (
    <span aria-hidden className={cn('grid size-9 shrink-0 place-items-center rounded-full [&_svg]:size-[18px]', cls)}>
      {icon}
    </span>
  );
}

const STATE_TONE: Record<CheckState, 'success' | 'danger' | 'warning' | 'neutral'> = {
  ok: 'success',
  missing: 'danger',
  warning: 'warning',
  optional: 'neutral',
  unsupported: 'neutral',
};

const str = (v: unknown) => (v === undefined ? '–' : String(v));

/** The plain-language line under each item's title. */
export function itemDetail(item: CheckItem, f: Pick<Formatters, 't' | 'number'>): string {
  const { t } = f;
  const p = item.params;
  if (item.error) return t('setup.checkFailed');
  switch (item.id) {
    case 'driver':
      if (item.state === 'ok') return t('setup.items.driver.ok', { version: str(p.driverVersion), cuda: str(p.cudaVersion) });
      if (item.state === 'unsupported') return t('setup.items.driver.unsupported');
      if (item.code === 'DRIVER_TOO_OLD') return t('setup.items.driver.tooOld', { version: str(p.driverVersion), min: str(p.minRequired) });
      return p.guidance ? t(`setup.driverGuide.${p.guidance as 'ubuntu-drivers'}`) : t('setup.items.driver.missing');
    case 'gpu':
      if (item.state === 'ok') return t('setup.items.gpu.ok', { name: str(p.name), vram: f.number(Number(p.vramGb), 0) });
      if (item.state === 'unsupported') return t('setup.items.gpu.unsupported', { name: str(p.name) });
      return item.code === 'DRIVER_MISSING' ? t('setup.items.gpu.needsDriver') : t('setup.items.gpu.missing');
    case 'llamacpp':
      if (item.state === 'ok') return t('setup.items.llamacpp.ok', { version: str(p.version), variant: prettyVariant(str(p.variant)) });
      if (item.code === 'ENGINE_MISSING_LIBRARY') return t('setup.items.llamacpp.missingLibrary', { library: str(p.library), package: str(p.package) });
      return item.state === 'warning' ? t('setup.items.llamacpp.broken') : t('setup.items.llamacpp.missing');
    case 'models':
      if (item.state !== 'ok') return t('setup.items.models.missing');
      return p.count === 1 ? t('setup.items.models.okOne') : t('setup.items.models.ok', { count: Number(p.count) });
    case 'disk':
      return t(item.state === 'ok' ? 'setup.items.disk.ok' : 'setup.items.disk.low', {
        free: f.number(Number(p.freeGb), 0),
        path: str(p.path),
        min: f.number(Number(p.minFreeGb), 0),
      });
    case 'docker':
      if (p.distroSupport) return t('setup.items.docker.distro');
      return t(`setup.items.docker.${(p.dockerState ?? 'unsupported') as 'running'}`, { version: str(p.version) });
    default:
      if (item.state === 'ok') return t('setup.items.vllm-native.ok', { version: str(p.version) });
      if (item.state === 'unsupported') return t('setup.items.vllm-native.unsupported');
      return p.uv ? t('setup.items.vllm-native.available') : t('setup.items.vllm-native.needsUv');
  }
}

/** Steps after which the item may have changed: re-check without cached detections. */
const RECHECK_AFTER = new Set(['done', 'running', 'installed', 'reboot-maybe-required', 'relogin-required']);

function CheckRow({ item, platform, onPickModel }: { item: CheckItem; platform: SystemCheckReport['platform']; onPickModel: () => void }) {
  const f = useI18n();
  const { t, bytes } = f;
  const navigate = useNavigate();
  const action = item.action;
  const installKey = action ? INSTALL_KEYS[action.kind] : undefined;
  const event = useInstallEvent(installKey ?? 'none');
  const start = useStartInstall();
  const recheck = useRecheck();
  const [confirm, setConfirm] = useState(false);
  const [driverOpened, setDriverOpened] = useState(false);
  const running = installKey === undefined ? undefined : activeEvent(event);
  const active = running !== undefined;
  const wasActive = useRef(active);

  useEffect(() => {
    if (wasActive.current && !active && event && RECHECK_AFTER.has(event.stage)) recheck.mutate();
    wasActive.current = active;
  }, [active, event, recheck]);

  const begin = () => {
    const kind = action?.kind as CheckActionKind;
    start.mutate({ key: INSTALL_KEYS[kind] as string, path: START_PATHS[kind] as string });
  };

  const run = () => {
    switch (action?.kind) {
      case 'open-driver-page':
        void window.gpubench?.openExternal(action.url as string);
        setDriverOpened(true);
        return;
      case 'pick-model':
        onPickModel();
        return;
      case 'free-disk':
        void navigate({ to: '/settings' });
        return;
      case 'install-docker':
      case 'install-docker-linux':
        setConfirm(true);
        return;
      default:
        begin();
    }
  };

  let label = '';
  if (action) {
    const base = t(`setup.actions.${action.kind === 'open-driver-page' && item.params.guidance ? 'open-driver-guide' : action.kind}`);
    label = action.bytes ? t('setup.actions.withSize', { label: base, size: bytes(action.bytes) }) : base;
  }
  const icon = action?.kind === 'start-docker' ? <Play aria-hidden /> : action?.kind === 'restart-docker' ? <RotateCcw aria-hidden /> : action?.kind === 'open-driver-page' ? <ExternalLink aria-hidden /> : action?.kind === 'free-disk' ? <FolderOpen aria-hidden /> : <Download aria-hidden />;
  const failed = !active && (event?.stage === 'error' || event?.stage === 'failed');
  const title = t(`setup.items.${item.id}.title`);

  return (
    <li className="flex flex-col gap-3 py-3.5 first:pt-1 last:pb-1">
      <div className="flex items-center gap-4">
        <CheckIcon state={item.state} />
        <div className="flex min-w-0 flex-1 flex-col">
          <p className="flex items-center gap-2 font-medium text-fg">
            <span className="text-fg-3 [&_svg]:size-4" aria-hidden>
              {ICONS[item.id]}
            </span>
            {title}
            <span className="sr-only">: {t(`setup.state.${item.state}`)}</span>
          </p>
          <p className="text-sm text-fg-2">{itemDetail(item, f)}</p>
        </div>
        {action && !active ? (
          <Button variant={item.required ? 'primary' : 'secondary'} size="sm" onClick={run} disabled={start.isPending} aria-label={`${label} (${title})`}>
            {icon}
            {label}
          </Button>
        ) : item.params.docs && !active ? (
          <Button size="sm" onClick={() => void window.gpubench?.openExternal(String(item.params.docs))}>
            <ExternalLink aria-hidden />
            {t('setup.actions.docker-docs')}
          </Button>
        ) : (
          !active && (
            <Badge tone={STATE_TONE[item.state]} size="sm">
              {t(`setup.state.${item.state}`)}
            </Badge>
          )
        )}
      </div>
      {running && <InstallProgress event={running} label={title} className="pl-[52px]" />}
      {failed && (
        <div className="pl-[52px]">
          {/* The final event of a failed install carries its error. */}
          <ErrorCallout error={event.error ?? { code: 'INTERNAL', message: event.stage }} />
        </div>
      )}
      {!active && (event?.stage === 'reboot-maybe-required' || event?.stage === 'relogin-required') && (
        <Callout tone="info" className="ml-[52px]" title={t(event.stage === 'relogin-required' ? 'setup.outcome.relogin' : 'setup.outcome.reboot')} />
      )}
      {driverOpened && (
        <Callout
          tone="info"
          className="ml-[52px]"
          title={t('setup.driverOpened')}
          action={{ label: t('setup.recheck'), onClick: () => recheck.mutate() }}
        />
      )}
      {confirm && <DockerInstallDialog platform={platform} open={confirm} onOpenChange={setConfirm} onConfirm={begin} />}
    </li>
  );
}

/** One sentence under the list: all good, fixable with the buttons above, or blocked by the driver. */
function CheckSummary({ report }: { report: SystemCheckReport }) {
  const { t } = useI18n();
  const blocking = report.items.filter((i) => i.required && i.state !== 'ok').length;
  if (blocking === 0) return <Callout tone="success" title={t('setup.summary.allGood')} className="mt-3" />;
  if (report.canBenchmark) return <Callout tone="info" title={blocking === 1 ? t('setup.summary.fixableOne') : t('setup.summary.fixable', { n: blocking })} className="mt-3" />;
  return <Callout tone="warning" title={t('setup.summary.blocked')} className="mt-3" />;
}

export interface SystemCheckProps {
  /** What "Scegli un modello" does here (welcome: next step; elsewhere: the Models page). */
  onPickModel: () => void;
  className?: string;
}

/** The "Controllo sistema" traffic lights: each problem has exactly one button that fixes it. */
export function SystemCheckPanel({ onPickModel, className }: SystemCheckProps) {
  const { t, relative } = useI18n();
  const check = useSystemCheck();
  const recheck = useRecheck();
  const report = check.data;

  return (
    <section aria-labelledby="system-check-title" className={cn('flex flex-col', className)}>
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 id="system-check-title" className="text-xl font-semibold tracking-[-0.015em]">
            {t('setup.title')}
          </h2>
          <p className="mt-1 text-sm text-fg-2">
            {report ? t('setup.intro', { when: relative(report.checkedAt) }) : t('setup.checking')}
          </p>
        </div>
        <Button variant="ghost" size="sm" onClick={() => recheck.mutate()} disabled={recheck.isPending || check.isFetching}>
          <RefreshCw aria-hidden className={cn((recheck.isPending || check.isFetching) && 'animate-spin')} />
          {t('setup.recheck')}
        </Button>
      </div>
      {check.isError && !report && <ErrorCallout error={check.error} className="mt-4" action={{ label: t('common.retry'), onClick: () => void check.refetch() }} />}
      {!report && !check.isError && (
        <div className="mt-4 flex flex-col gap-3" aria-hidden>
          {[0, 1, 2, 3, 4].map((i) => (
            <Skeleton key={i} className="h-12" />
          ))}
        </div>
      )}
      {report && (
        <>
          <ul className="mt-3 divide-y divide-border">
            {report.items
              // Optional extras this system cannot have (vLLM native on Windows) are only noise here.
              .filter((item) => item.required || item.state !== 'unsupported')
              .map((item) => (
              <CheckRow key={item.id} item={item} platform={report.platform} onPickModel={onPickModel} />
            ))}
          </ul>
          <CheckSummary report={report} />
        </>
      )}
    </section>
  );
}
