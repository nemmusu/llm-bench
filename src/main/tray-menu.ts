/**
 * The tray menu as plain data, from what the core says runs (contract ShellState): pure, so it is
 * tested on its own and rendered as a list in a snapshot. shell.ts turns it into an Electron menu.
 *
 *   Apri LLM Bench
 *   ───
 *   Qwen3 8B · porta 8080            (one section per running server)
 *     Copia indirizzo
 *     Ferma (chiudi modello)
 *     Riavvia
 *   ───
 *   Avvia preset ▸                    (the saved presets)
 *   Ferma tutti i server
 *   ───
 *   Docker: non risponde              (Docker's state, where LLM Bench can start or restart it)
 *   Riavvia Docker                    (or "Avvia Docker" when it is off)
 *   ───
 *   Esci
 */
import type { ShellDocker, ShellState } from '../contract/servers';
import { trayText, type TrayLang } from './tray-text';

export type TrayCommand =
  | { kind: 'open' }
  | { kind: 'copy'; url: string }
  | { kind: 'stop'; id: string }
  | { kind: 'restart'; id: string }
  | { kind: 'start-preset'; id: string }
  | { kind: 'stop-all' }
  | { kind: 'docker-start' }
  | { kind: 'docker-restart' }
  | { kind: 'quit' };

export interface TrayItem {
  type?: 'separator';
  label?: string;
  enabled?: boolean;
  /** A heading of a section (shown greyed out). */
  heading?: boolean;
  command?: TrayCommand;
  submenu?: TrayItem[];
}

/** What the icon shows: nothing running, a server running, a server starting. */
export type TrayStatus = 'idle' | 'running' | 'loading';

const SEPARATOR: TrayItem = { type: 'separator' };

export function trayStatus(state: ShellState | undefined): TrayStatus {
  const servers = state?.servers ?? [];
  if (servers.some((s) => s.status === 'loading')) return 'loading';
  return servers.length ? 'running' : 'idle';
}

export function trayMenu(state: ShellState | undefined, lang: TrayLang): TrayItem[] {
  const t = (k: Parameters<typeof trayText>[1], p?: Record<string, string | number>) => trayText(lang, k, p);
  const servers = state?.servers ?? [];
  const presets = state?.presets ?? [];
  const items: TrayItem[] = [{ label: t('open'), command: { kind: 'open' } }];
  for (const s of servers) {
    const key = s.status === 'loading' ? 'serverLoading' : s.network === 'lan' ? 'serverLan' : 'server';
    items.push(
      SEPARATOR,
      { label: t(key, { model: s.presetName ?? s.modelName, port: s.port }), enabled: false, heading: true },
      { label: t('copy'), command: { kind: 'copy', url: s.url } },
      { label: t('stop'), command: { kind: 'stop', id: s.id } },
      { label: t('restart'), command: { kind: 'restart', id: s.id }, enabled: s.status === 'ready' },
    );
  }
  items.push(SEPARATOR, {
    label: t('startPreset'),
    submenu: presets.length
      ? presets.map((p) => ({
          label: p.running ? t('presetRunning', { name: p.name }) : p.port !== undefined ? t('presetPort', { name: p.name, port: p.port }) : p.name,
          enabled: !p.running,
          command: { kind: 'start-preset', id: p.id },
        }))
      : [{ label: t('noPresets'), enabled: false }],
  });
  items.push({ label: t('stopAll'), command: { kind: 'stop-all' }, enabled: servers.length > 0 }, ...dockerSection(state?.docker, t), SEPARATOR, { label: t('quit'), command: { kind: 'quit' } });
  return items;
}

/**
 * Docker's state and the one command that helps: "Avvia Docker" when it is off, "Riavvia Docker"
 * when it does not answer (and while it runs). Shown where LLM Bench can start it (Docker Desktop on
 * Windows); elsewhere only when it does not answer.
 */
function dockerSection(d: ShellDocker | undefined, t: (k: Parameters<typeof trayText>[1]) => string): TrayItem[] {
  if (!d || !(d.control || d.state === 'not-responding')) return [];
  const heading = (key: Parameters<typeof trayText>[1]): TrayItem => ({ label: t(key), enabled: false, heading: true });
  if (d.busy) return [SEPARATOR, heading(d.busy === 'restarting' ? 'dockerRestarting' : 'dockerStarting')];
  const restart: TrayItem[] = d.control ? [{ label: t('dockerRestart'), command: { kind: 'docker-restart' } }] : [];
  switch (d.state) {
    case 'not-responding':
      return [SEPARATOR, heading('dockerStuck'), ...restart];
    case 'running':
      return [SEPARATOR, heading('dockerRunning'), ...restart];
    case 'stopped':
      return [SEPARATOR, heading('dockerStopped'), { label: t('dockerStart'), command: { kind: 'docker-start' } }];
    case 'starting':
      return [SEPARATOR, heading('dockerStarting')];
    default:
      // Not installed, no GPU, no permission…: the window explains those.
      return [];
  }
}

/** Windows cuts tray tooltips at 127 characters. */
export const TOOLTIP_MAX = 127;

export function trayTooltip(state: ShellState | undefined, lang: TrayLang): string {
  const servers = state?.servers ?? [];
  // A stuck Docker is why servers stopped working: said in the tooltip too.
  const stuck = state?.docker?.state === 'not-responding' ? ` · ${trayText(lang, 'tooltipDockerStuck')}` : '';
  if (!servers.length) return `${trayText(lang, 'tooltipIdle')}${stuck}`;
  // Each server named as in the menu (its preset's name when it has one).
  const list = servers
    .map((s) => {
      const name = s.presetName ?? s.modelName;
      return s.status === 'loading' ? trayText(lang, 'tooltipLoading', { model: name }) : `${name} (${s.port})`;
    })
    .join(', ');
  const text = `${servers.length === 1 ? trayText(lang, 'tooltipOne', { list }) : trayText(lang, 'tooltipMany', { n: servers.length, list })}${stuck}`;
  return text.length > TOOLTIP_MAX ? `${text.slice(0, TOOLTIP_MAX - 1)}…` : text;
}

/** The menu as indented lines (snapshot tests and the E2E test hook): "---" separators, "(x)" disabled, "▸" submenus. */
export function menuLines(items: readonly TrayItem[], depth = 0): string[] {
  const pad = '  '.repeat(depth);
  return items.flatMap((i) => {
    if (i.type === 'separator') return [`${pad}---`];
    const line = `${pad}${i.label}${i.submenu ? ' ▸' : ''}${i.enabled === false && !i.heading ? ' (x)' : ''}`;
    return i.submenu ? [line, ...menuLines(i.submenu, depth + 1)] : [line];
  });
}

/**
 * The command of the item at `path`, for the E2E test hook: labels from the top, a submenu's label or
 * a server's heading first ("Qwen3 8B · porta 8080", "Ferma (chiudi modello)"). Disabled items have none.
 */
export function findCommand(items: readonly TrayItem[], path: readonly string[]): TrayCommand | undefined {
  const [head, ...rest] = path;
  const idx = items.findIndex((i) => i.label === head && (i.heading === true || i.enabled !== false));
  const hit = items[idx];
  if (!hit) return undefined;
  if (!rest.length) return hit.command;
  if (hit.submenu) return findCommand(hit.submenu, rest);
  // A server's heading: its section runs to the next separator.
  const section: TrayItem[] = [];
  for (let k = idx + 1; k < items.length && items[k]!.type !== 'separator'; k++) section.push(items[k]!);
  return findCommand(section, rest);
}
