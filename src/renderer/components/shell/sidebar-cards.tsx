/**
 * What is going on, always one click away from the sidebar: the benchmark in progress (its live
 * screen) and the servers that are on (the Server page). Both shrink to an icon in the collapsed
 * sidebar, with the same accessible name.
 */
import { Link, useRouterState } from '@tanstack/react-router';
import { Activity, ArrowUpRight, Server } from 'lucide-react';
import { useI18n } from '../../i18n';
import { useServers, useShellActiveRun } from '../../lib/queries-runs';
import { useServersLiveRefresh } from '../../lib/queries-servers';
import { StatusDot } from '../ui/status-dot';
import { Tooltip } from '../ui/tooltip';

/**
 * The in-progress benchmark: while a run is active (and we are not already on its live screen) this
 * card links straight to it, so leaving the page never means losing it.
 */
export function ActiveRunCard({ collapsed }: { collapsed: boolean }) {
  const { t } = useI18n();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  // Polled as a backstop; the SSE events make it appear and disappear within a second.
  const active = useShellActiveRun().data?.active;
  if (!active || pathname.startsWith('/run/')) return null;
  const title = t('shell.activeRunTitle');
  const percent = Math.round(Math.min(1, Math.max(0, active.progress)) * 100);
  const phase = t(`phases.${active.phase}.label`);
  const label = `${title}: ${active.modelName}, ${phase}, ${percent}%`;

  if (collapsed) {
    return (
      <Tooltip content={`${title}: ${active.modelName}`} side="right">
        <Link to="/run/$runId" params={{ runId: active.runId }} aria-label={label} className="grid h-9 place-items-center rounded-lg focus-ring">
          <span aria-hidden className="grid size-8 place-items-center rounded-full p-[3px]" style={{ background: `conic-gradient(var(--accent) ${percent}%, var(--surface-3) 0)` }}>
            <span className="grid size-full place-items-center rounded-full bg-surface">
              <StatusDot tone="accent" pulse />
            </span>
          </span>
        </Link>
      </Tooltip>
    );
  }

  return (
    <Link
      to="/run/$runId"
      params={{ runId: active.runId }}
      aria-label={label}
      className="group flex flex-col gap-2 rounded-lg border border-accent/35 bg-surface p-3 shadow-xs transition-colors hover:border-accent/70 focus-ring"
    >
      <span className="flex items-center gap-2">
        <span aria-hidden className="grid size-6 shrink-0 place-items-center rounded-md bg-accent-soft text-accent-text">
          <Activity className="size-3.5" />
        </span>
        <span className="min-w-0 flex-1 truncate text-xs font-semibold text-fg">{title}</span>
        <ArrowUpRight aria-hidden className="size-3.5 shrink-0 text-fg-3 transition-colors group-hover:text-accent-text" />
      </span>
      <span className="truncate text-xs text-fg-2">{active.modelName}</span>
      <span aria-hidden className="h-1.5 overflow-hidden rounded-full bg-surface-3">
        <span className="block h-full rounded-full bg-[linear-gradient(90deg,var(--accent),var(--accent-2))] transition-[width] duration-500" style={{ width: `${percent}%` }} />
      </span>
      <span className="flex items-center justify-between gap-2 text-2xs text-fg-3 tabular-nums">
        <span className="flex min-w-0 items-center gap-1.5">
          <StatusDot tone="accent" pulse />
          <span className="truncate">{phase}</span>
        </span>
        <span>{percent}%</span>
      </span>
    </Link>
  );
}

/** "Server attivi": how many, the first one's model and port; a link to the Server page (hidden there). */
export function ServersCard({ collapsed }: { collapsed: boolean }) {
  const { t } = useI18n();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  useServersLiveRefresh();
  const list = useServers().data ?? [];
  const first = list[0];
  if (!first || pathname.startsWith('/servers')) return null;
  const loading = list.some((s) => s.loading);
  const title = t('shell.serversTitle');
  const name = first.presetName ?? first.modelLabel;
  const label = t('shell.serversLabel', { n: list.length, model: name, port: first.port });

  if (collapsed) {
    return (
      <Tooltip content={label} side="right">
        <Link to="/servers" aria-label={label} className="relative grid h-9 place-items-center rounded-lg text-success-text hover:bg-surface-2 focus-ring">
          <Server aria-hidden className="size-[18px]" />
          <span aria-hidden className="absolute top-0.5 right-1.5 grid min-w-4 place-items-center rounded-full bg-success-solid px-1 text-[10px] leading-4 font-semibold text-white tabular-nums">
            {list.length}
          </span>
        </Link>
      </Tooltip>
    );
  }

  return (
    <Link to="/servers" aria-label={label} className="group flex flex-col gap-1.5 rounded-lg border border-success/35 bg-surface p-3 shadow-xs transition-colors hover:border-success/70 focus-ring">
      <span className="flex items-center gap-2">
        <span aria-hidden className="grid size-6 shrink-0 place-items-center rounded-md bg-success-soft text-success-text">
          <Server className="size-3.5" />
        </span>
        <span className="min-w-0 flex-1 truncate text-xs font-semibold text-fg">{title}</span>
        <span aria-hidden className="rounded-full bg-success-soft px-1.5 text-2xs font-semibold text-success-text tabular-nums">
          {list.length}
        </span>
        <ArrowUpRight aria-hidden className="size-3.5 shrink-0 text-fg-3 transition-colors group-hover:text-success-text" />
      </span>
      <span className="flex min-w-0 items-center gap-1.5 text-xs text-fg-2">
        <StatusDot tone={first.loading ? 'warning' : 'success'} pulse={first.loading !== undefined} />
        <span className="min-w-0 truncate">{t('shell.serversOne', { model: name, port: first.port })}</span>
      </span>
      {(list.length > 1 || loading) && (
        <span className="text-2xs text-fg-3">
          {list.length > 1 ? t('shell.serversMore', { n: list.length - 1 }) : ''}
          {list.length > 1 && loading ? ' · ' : ''}
          {loading ? t('shell.serversLoading') : ''}
        </span>
      )}
    </Link>
  );
}
