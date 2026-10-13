import { Activity, Boxes, ChartNoAxesColumnIncreasing, Cpu, Gauge, Server, Settings, type LucideIcon } from 'lucide-react';
import type { MessageKey } from '../i18n';

export type NavId = 'benchmark' | 'servers' | 'results' | 'models' | 'engines' | 'monitor' | 'settings';

export interface NavItem {
  id: NavId;
  to: '/' | '/servers' | '/results' | '/models' | '/engines' | '/monitor' | '/settings';
  label: MessageKey;
  icon: LucideIcon;
}

export const NAV_MAIN: readonly NavItem[] = [
  { id: 'benchmark', to: '/', label: 'nav.benchmark', icon: Gauge },
  { id: 'servers', to: '/servers', label: 'nav.servers', icon: Server },
  { id: 'results', to: '/results', label: 'nav.results', icon: ChartNoAxesColumnIncreasing },
  { id: 'models', to: '/models', label: 'nav.models', icon: Boxes },
  { id: 'engines', to: '/engines', label: 'nav.engines', icon: Cpu },
  { id: 'monitor', to: '/monitor', label: 'nav.monitor', icon: Activity },
];

export const NAV_SETTINGS: NavItem = { id: 'settings', to: '/settings', label: 'nav.settings', icon: Settings };

/** Which sidebar entry owns a path (live runs belong to Benchmark, compare to Results). */
export function navIdFor(pathname: string): NavId | undefined {
  if (pathname === '/' || pathname.startsWith('/run')) return 'benchmark';
  if (pathname.startsWith('/results') || pathname.startsWith('/compare')) return 'results';
  for (const id of ['servers', 'models', 'engines', 'monitor', 'settings'] as const) if (pathname.startsWith(`/${id}`)) return id;
  return undefined;
}

/** Title shown in the title bar for a path. */
export function pageTitleKey(pathname: string): MessageKey {
  if (pathname.startsWith('/welcome')) return 'nav.welcome';
  if (pathname.startsWith('/run/')) return 'nav.run';
  if (pathname.startsWith('/results/')) return 'nav.result';
  if (pathname.startsWith('/compare')) return 'nav.compare';
  if (pathname.startsWith('/servers/new')) return 'nav.serverStart';
  const id = navIdFor(pathname);
  return id ? `nav.${id}` : 'nav.benchmark';
}
