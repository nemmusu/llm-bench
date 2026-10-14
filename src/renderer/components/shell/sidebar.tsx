import { Link, useRouterState } from '@tanstack/react-router';
import { PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { useI18n } from '../../i18n';
import { useCoreConnected } from '../../lib/api-context';
import { cn } from '../../lib/cn';
import { NAV_MAIN, NAV_SETTINGS, navIdFor, type NavItem } from '../../lib/nav';
import { useGpuSnapshot, useSystemInfo } from '../../lib/queries-library';
import { VersionLabel } from '../domain/version-label';
import { IconButton } from '../ui/button';
import { ActiveRunCard, ServersCard } from './sidebar-cards';
import { Skeleton } from '../ui/skeleton';
import { StatusDot } from '../ui/status-dot';
import { Tooltip } from '../ui/tooltip';

function NavLink({ item, active, collapsed }: { item: NavItem; active: boolean; collapsed: boolean }) {
  const { t } = useI18n();
  const label = t(item.label);
  const Icon = item.icon;
  const link = (
    <Link
      to={item.to}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'group relative flex h-9 items-center gap-3 rounded-md px-2.5 text-sm font-medium transition-colors focus-ring',
        active ? 'bg-surface text-fg shadow-xs ring-1 ring-border' : 'text-fg-2 hover:bg-surface-2 hover:text-fg',
        collapsed && 'justify-center px-0',
      )}
    >
      {active && <span aria-hidden className="absolute top-2 bottom-2 -left-3 w-[3px] rounded-r-full bg-accent" />}
      <Icon aria-hidden className={cn('size-[18px] shrink-0', active ? 'text-accent-text' : 'text-fg-3 group-hover:text-fg-2')} />
      <span className={cn(collapsed && 'sr-only')}>{label}</span>
    </Link>
  );
  return collapsed ? (
    <Tooltip content={label} side="right">
      {link}
    </Tooltip>
  ) : (
    link
  );
}

function GpuStatus({ collapsed }: { collapsed: boolean }) {
  const { t, number } = useI18n();
  const connected = useCoreConnected();
  const system = useSystemInfo();
  const snapshot = useGpuSnapshot(2000);
  const gpu = system.data?.gpus.find((g) => g.vendor === 'nvidia');
  const sample = snapshot.data?.find((s) => s.gpu === gpu?.index);
  const usedGb = (sample?.memUsedMiB ?? gpu?.memoryUsedMiB ?? 0) / 1024;
  const totalGb = (gpu?.memoryTotalMiB ?? 0) / 1024;
  const coreText = connected ? t('shell.coreConnected') : t('shell.coreDisconnected');

  if (collapsed) {
    return (
      <Tooltip content={coreText} side="right">
        <div role="status" aria-label={coreText} className="grid h-9 place-items-center">
          <StatusDot tone={connected ? 'success' : 'danger'} pulse={connected} />
        </div>
      </Tooltip>
    );
  }
  return (
    <section aria-label={t('shell.gpuStatus')} className="rounded-lg border border-border bg-surface p-3 shadow-xs">
      {system.isPending ? (
        <Skeleton className="h-10" />
      ) : gpu ? (
        <>
          <p className="truncate text-xs font-semibold text-fg" title={gpu.name}>
            {gpu.name.replace('NVIDIA GeForce ', '')}
          </p>
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-surface-3" aria-hidden>
            <div
              className="h-full rounded-full bg-[linear-gradient(90deg,var(--accent),var(--accent-2))]"
              style={{ width: `${Math.min(100, (usedGb / totalGb) * 100)}%` }}
            />
          </div>
          <p className="mt-1.5 text-2xs text-fg-3 tabular-nums">
            {t('shell.vramUsed', { used: `${number(usedGb, 1)} GB`, total: `${number(totalGb, 1)} GB` })}
          </p>
        </>
      ) : (
        <p className="text-xs text-fg-3">{t('shell.noGpu')}</p>
      )}
      <div role="status" className="mt-2.5 flex items-center gap-2 border-t border-border pt-2.5 text-2xs text-fg-2">
        <StatusDot tone={connected ? 'success' : 'danger'} pulse={connected} />
        <span>{connected ? t('shell.coreConnectedShort') : t('shell.coreDisconnectedShort')}</span>
        <span className="sr-only">{coreText}</span>
      </div>
    </section>
  );
}

/**
 * Left navigation: seven destinations, what is running right now (a benchmark, the servers),
 * collapsible to icons, GPU + core status at the bottom.
 */
export function Sidebar({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) {
  const { t } = useI18n();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const activeId = navIdFor(pathname);

  return (
    <aside className={cn('flex shrink-0 flex-col gap-2 pb-3 transition-[width] duration-200', collapsed ? 'w-[60px] px-2' : 'w-[232px] px-3')}>
      <nav aria-label={t('nav.main')} className="flex flex-1 flex-col pt-2">
        <ul className="flex flex-col gap-0.5">
          {NAV_MAIN.map((item) => (
            <li key={item.id}>
              <NavLink item={item} active={activeId === item.id} collapsed={collapsed} />
            </li>
          ))}
        </ul>
        <div className="mt-4 flex flex-col gap-2">
          <ActiveRunCard collapsed={collapsed} />
          <ServersCard collapsed={collapsed} />
        </div>
        <ul className="mt-auto flex flex-col gap-0.5 pt-4">
          <li>
            <NavLink item={NAV_SETTINGS} active={activeId === 'settings'} collapsed={collapsed} />
          </li>
        </ul>
      </nav>
      <GpuStatus collapsed={collapsed} />
      <div className={cn('flex items-center gap-2 px-1', collapsed ? 'flex-col' : 'justify-between')}>
        <VersionLabel />
        <IconButton
          size="sm"
          label={collapsed ? t('nav.expand') : t('nav.collapse')}
          icon={collapsed ? <PanelLeftOpen /> : <PanelLeftClose />}
          onClick={onToggle}
          aria-expanded={!collapsed}
        />
      </div>
    </aside>
  );
}
