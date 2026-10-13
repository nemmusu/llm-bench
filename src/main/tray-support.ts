/**
 * Whether this desktop shows tray icons. Windows always does. On Linux, Electron's tray is a
 * StatusNotifierItem (AppIndicator), falling back to the old XEmbed tray on X11: KDE, Cinnamon, XFCE,
 * MATE, Budgie and Ubuntu's GNOME show it; plain GNOME needs the "AppIndicator" extension. Without a
 * tray, closing the window minimizes it instead of hiding it (close-behavior.ts).
 */
import { execFile } from 'node:child_process';

export interface CommandResult {
  code: number | null;
  stdout: string;
}

export type RunCommand = (cmd: string, args: readonly string[]) => Promise<CommandResult>;

/** Runs a small program (2 s at most); never throws: a missing program is code null. */
export function runCommand(cmd: string, args: readonly string[], timeoutMs = 2000): Promise<CommandResult> {
  return new Promise((resolve) => {
    execFile(cmd, [...args], { timeout: timeoutMs, windowsHide: true }, (err, stdout) => {
      const code = err ? (typeof err.code === 'number' ? err.code : null) : 0;
      resolve({ code, stdout: String(stdout) });
    });
  });
}

const WATCHER = 'org.kde.StatusNotifierWatcher';

/**
 * Does a panel collect StatusNotifierItems (org.kde.StatusNotifierWatcher has an owner on the session
 * bus)? Asked with gdbus, else dbus-send; undefined when neither can tell.
 */
export async function statusNotifierHost(run: RunCommand): Promise<boolean | undefined> {
  const gdbus = await run('gdbus', ['call', '--session', '--dest', 'org.freedesktop.DBus', '--object-path', '/org/freedesktop/DBus', '--method', 'org.freedesktop.DBus.NameHasOwner', WATCHER]);
  if (gdbus.code === 0) return /\btrue\b/.test(gdbus.stdout);
  const send = await run('dbus-send', ['--session', '--print-reply', '--dest=org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus.NameHasOwner', `string:${WATCHER}`]);
  if (send.code === 0) return /boolean true/.test(send.stdout);
  return undefined;
}

export interface TraySupportHost {
  platform: string;
  env: NodeJS.ProcessEnv;
  run: RunCommand;
}

export async function trayAvailable(h: TraySupportHost): Promise<boolean> {
  // Tests (and anyone who wants no icon) can turn it off.
  if (h.env.GPUBENCH_NO_TRAY === '1') return false;
  if (h.platform !== 'linux') return true;
  const gnome = /gnome/i.test(h.env.XDG_CURRENT_DESKTOP ?? '');
  const sni = await statusNotifierHost(h.run);
  if (sni === true) return true;
  // No StatusNotifier panel: only the X11 tray of a desktop other than GNOME is left.
  if (sni === false) return !gnome && h.env.XDG_SESSION_TYPE !== 'wayland';
  return !gnome;
}
