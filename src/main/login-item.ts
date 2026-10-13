/**
 * "Avvia LLM Bench all'accesso" (opt-in): the Windows login item (Electron's setLoginItemSettings,
 * the registry Run key of this user, value "LLM Bench"), or an XDG autostart entry on Linux
 * (~/.config/autostart/llm-bench.desktop). Started that way, LLM Bench opens in the tray (--hidden).
 *
 * GPUBENCH_FAKE_LOGIN_ITEM=<file>: tests never touch the real login items; the state goes to that file.
 */
import path from 'node:path';
import { APP_ID, APP_NAME, LEGACY_APP_ID } from './app-name';
import type { RunCommand } from './tray-support';

export const HIDDEN_ARG = '--hidden';
export const AUTOSTART_NAME = `${APP_ID}.desktop`;
/** GPU Bench's entry (the name before 0.4.0), replaced once by migrateLegacyLoginItem. */
export const LEGACY_AUTOSTART_NAME = `${LEGACY_APP_ID}.desktop`;

export interface LoginItemSettings {
  openAtLogin: boolean;
  path?: string;
  args?: string[];
  /** Windows: the registry value's name. */
  name?: string;
  /** Windows: "enabled" in Task Manager (the StartupApproved key); Electron's default is true. */
  enabled?: boolean;
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
  getLoginItemSettings(o: { path: string; args: string[]; name: string }): { openAtLogin: boolean };
  setLoginItemSettings(s: LoginItemSettings): void;
  /** Small programs: `reg query` finds GPU Bench's login item (Windows). */
  run: RunCommand;
}

/** ~/.config/autostart/llm-bench.desktop (XDG_CONFIG_HOME when set). */
export function autostartFile(env: NodeJS.ProcessEnv, home: string, name = AUTOSTART_NAME): string {
  return path.posix.join(env.XDG_CONFIG_HOME || path.posix.join(home, '.config'), 'autostart', name);
}

/** Desktop Entry Exec quoting: arguments with reserved characters in double quotes, `"` `` ` `` `$` `\` escaped inside. */
export function execArg(a: string): string {
  if (a !== '' && !/[\s"'\\><~|&;$*?#()`]/.test(a)) return a;
  return `"${a.replace(/(["`$\\])/g, '\\$1')}"`;
}

/** The program and arguments that start LLM Bench in the tray: the AppImage itself when run from one. */
export function launchArgv(h: Pick<LoginItemHost, 'env' | 'execPath' | 'appPath'>): string[] {
  const exe = h.env.APPIMAGE || h.env.PORTABLE_EXECUTABLE_FILE || h.execPath;
  return [exe, ...(h.appPath !== undefined ? [h.appPath] : []), HIDDEN_ARG];
}

/** The autostart entry; string values escape backslashes once more (Desktop Entry spec). */
export function autostartEntry(argv: readonly string[], enabled = true): string {
  const exec = argv.map(execArg).join(' ').replace(/\\/g, '\\\\');
  return ['[Desktop Entry]', 'Type=Application', `Name=${APP_NAME}`, `Exec=${exec}`, `X-GNOME-Autostart-enabled=${enabled}`, 'Terminal=false', `Comment=${APP_NAME}`, ''].join('\n');
}

async function exists(h: LoginItemHost, file: string): Promise<boolean> {
  return h.fs.readFile(file).then(
    () => true,
    () => false,
  );
}

/** Whether LLM Bench starts at login now. */
export async function loginItemEnabled(h: LoginItemHost): Promise<boolean> {
  const fake = h.env.GPUBENCH_FAKE_LOGIN_ITEM;
  if (fake) {
    const raw = await h.fs.readFile(fake).then(String, () => '{}');
    return (JSON.parse(raw) as { openAtLogin?: boolean }).openAtLogin === true;
  }
  if (h.platform === 'linux') return exists(h, autostartFile(h.env, h.home));
  const [exe, ...args] = launchArgv(h) as [string, ...string[]];
  return h.getLoginItemSettings({ path: exe, args, name: APP_NAME }).openAtLogin;
}

/** Turns "Avvia LLM Bench all'accesso" on or off. */
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
  h.setLoginItemSettings({ openAtLogin: enabled, path: exe, args, name: APP_NAME });
}

export const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
export const STARTUP_APPROVED_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run';
/** GPU Bench's login item started its own exe (installed "GPU Bench.exe", or the portable GPU-Bench-x.y.z-portable.exe) hidden. */
const LEGACY_COMMAND = /GPU[ -]Bench[^\\/]*\.exe"?\s+--hidden\b/i;

/** `reg query` output: "    <name>    REG_SZ    <data>" lines (names may contain spaces). */
export function regValues(stdout: string): { name: string; data: string }[] {
  return stdout.split(/\r?\n/).flatMap((line) => {
    const m = /^ {4}(.+?) {4}REG_[A-Z_]+ {4}(.*)$/.exec(line);
    return m ? [{ name: m[1] as string, data: (m[2] as string).trim() }] : [];
  });
}

/**
 * GPU Bench's start at login, moved to LLM Bench once (the first start after the rename): the old
 * entry is removed and, when there was one, LLM Bench's is made with the same state (Linux: the
 * X-GNOME-Autostart-enabled key; Windows: "disabled" in Task Manager, StartupApproved 03…). Windows
 * names the value after GPU Bench's app id, so it is found by its command. True when one was moved.
 */
export async function migrateLegacyLoginItem(h: LoginItemHost): Promise<boolean> {
  if (h.env.GPUBENCH_FAKE_LOGIN_ITEM) return false;
  if (h.platform === 'linux') {
    const old = autostartFile(h.env, h.home, LEGACY_AUTOSTART_NAME);
    const raw = await h.fs.readFile(old).then(String, () => undefined);
    if (raw === undefined) return false;
    const file = autostartFile(h.env, h.home);
    await h.fs.mkdir(path.posix.dirname(file), { recursive: true });
    await h.fs.writeFile(file, autostartEntry(launchArgv(h), !/^X-GNOME-Autostart-enabled=false\s*$/m.test(raw)));
    await h.fs.rm(old, { force: true });
    return true;
  }
  if (h.platform !== 'win32') return false;
  const old = regValues((await h.run('reg', ['query', RUN_KEY])).stdout).filter((v) => LEGACY_COMMAND.test(v.data));
  if (old.length === 0) return false;
  const approved = regValues((await h.run('reg', ['query', STARTUP_APPROVED_KEY])).stdout);
  // StartupApproved: 02… enabled, 03… turned off by the user in Task Manager (no value: enabled).
  const enabled = old.some((v) => !/^0[37]/.test(approved.find((a) => a.name === v.name)?.data ?? ''));
  for (const v of old) h.setLoginItemSettings({ openAtLogin: false, name: v.name });
  const [exe, ...args] = launchArgv(h) as [string, ...string[]];
  h.setLoginItemSettings({ openAtLogin: true, path: exe, args, name: APP_NAME, enabled });
  return true;
}
