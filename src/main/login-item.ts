/**
 * "Avvia GPU Bench all'accesso" (opt-in): the Windows login item (Electron's setLoginItemSettings,
 * the registry Run key of this user), or an XDG autostart entry on Linux
 * (~/.config/autostart/gpu-bench.desktop). Started that way, GPU Bench opens in the tray (--hidden).
 *
 * GPUBENCH_FAKE_LOGIN_ITEM=<file>: tests never touch the real login items; the state goes to that file.
 */
import path from 'node:path';
import { APP_ID, APP_NAME } from './app-name';

export const HIDDEN_ARG = '--hidden';
export const AUTOSTART_NAME = `${APP_ID}.desktop`;

export interface LoginItemSettings {
  openAtLogin: boolean;
  path?: string;
  args?: string[];
}

export interface LoginItemHost {
  platform: string;
  env: NodeJS.ProcessEnv;
  home: string;
  /** The Electron executable (packaged: the app itself). */
  execPath: string;
  /** Unpackaged runs: the app folder Electron needs as its first argument. */
  appPath?: string;
  fs: {
    readFile(p: string): Promise<Buffer>;
    writeFile(p: string, data: string | Buffer, opts?: unknown): Promise<void>;
    mkdir(p: string, opts: { recursive: true }): Promise<unknown>;
    rm(p: string, opts: { force: true }): Promise<void>;
  };
  getLoginItemSettings(o: { path: string; args: string[] }): { openAtLogin: boolean };
  setLoginItemSettings(s: LoginItemSettings): void;
}

/** ~/.config/autostart/gpu-bench.desktop (XDG_CONFIG_HOME when set). */
export function autostartFile(env: NodeJS.ProcessEnv, home: string): string {
  return path.posix.join(env.XDG_CONFIG_HOME || path.posix.join(home, '.config'), 'autostart', AUTOSTART_NAME);
}

/** Desktop Entry Exec quoting: arguments with reserved characters in double quotes, `"` `` ` `` `$` `\` escaped inside. */
export function execArg(a: string): string {
  if (a !== '' && !/[\s"'\\><~|&;$*?#()`]/.test(a)) return a;
  return `"${a.replace(/(["`$\\])/g, '\\$1')}"`;
}

/** The program and arguments that start GPU Bench in the tray: the AppImage itself when run from one. */
export function launchArgv(h: Pick<LoginItemHost, 'env' | 'execPath' | 'appPath'>): string[] {
  const exe = h.env.APPIMAGE || h.env.PORTABLE_EXECUTABLE_FILE || h.execPath;
  return [exe, ...(h.appPath !== undefined ? [h.appPath] : []), HIDDEN_ARG];
}

/** The autostart entry; string values escape backslashes once more (Desktop Entry spec). */
export function autostartEntry(argv: readonly string[]): string {
  const exec = argv.map(execArg).join(' ').replace(/\\/g, '\\\\');
  return ['[Desktop Entry]', 'Type=Application', `Name=${APP_NAME}`, `Exec=${exec}`, 'X-GNOME-Autostart-enabled=true', 'Terminal=false', `Comment=${APP_NAME}`, ''].join('\n');
}

async function exists(h: LoginItemHost, file: string): Promise<boolean> {
  return h.fs.readFile(file).then(
    () => true,
    () => false,
  );
}

/** Whether GPU Bench starts at login now. */
export async function loginItemEnabled(h: LoginItemHost): Promise<boolean> {
  const fake = h.env.GPUBENCH_FAKE_LOGIN_ITEM;
  if (fake) {
    const raw = await h.fs.readFile(fake).then(String, () => '{}');
    return (JSON.parse(raw) as { openAtLogin?: boolean }).openAtLogin === true;
  }
  if (h.platform === 'linux') return exists(h, autostartFile(h.env, h.home));
  const [exe, ...args] = launchArgv(h) as [string, ...string[]];
  return h.getLoginItemSettings({ path: exe, args }).openAtLogin;
}

/** Turns "Avvia GPU Bench all'accesso" on or off. */
export async function setLoginItem(h: LoginItemHost, enabled: boolean): Promise<void> {
  const fake = h.env.GPUBENCH_FAKE_LOGIN_ITEM;
  if (fake) {
    await h.fs.writeFile(fake, JSON.stringify({ openAtLogin: enabled, argv: launchArgv(h) }));
    return;
  }
  if (h.platform === 'linux') {
    const file = autostartFile(h.env, h.home);
    if (!enabled) return h.fs.rm(file, { force: true });
    await h.fs.mkdir(path.posix.dirname(file), { recursive: true });
    await h.fs.writeFile(file, autostartEntry(launchArgv(h)));
    return;
  }
  const [exe, ...args] = launchArgv(h) as [string, ...string[]];
  h.setLoginItemSettings({ openAtLogin: enabled, path: exe, args });
}
