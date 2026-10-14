import type {
  App,
  BrowserWindow as BrowserWindowType,
  BrowserWindowConstructorOptions,
  Dialog,
  FileFilter,
  IpcMain,
  Menu as MenuType,
  MenuItemConstructorOptions,
  NativeImage,
  NativeTheme,
  SafeStorage,
  Shell,
  UtilityProcess,
} from 'electron';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import type { AppNotice } from '../contract/app-notices';
import { shellStateSchema, type ShellState as CoreState } from '../contract/servers';
import { APP_NAME, LEGACY_APP_NAME } from './app-name';
import { closeAction, shouldExplainHide, startupWindow } from './close-behavior';
import { HIDDEN_ARG, loginItemEnabled, migrateLegacyLoginItem, setLoginItem, type LoginItemHost } from './login-item';
import { addAppNotices, finishLegacyMove, moveLegacyData, movedNotice, type LegacyAsyncFs, type LegacyMove, type LegacySyncFs } from './migrate';
import { findCommand, menuLines, trayMenu, trayStatus, trayTooltip, type TrayCommand, type TrayItem, type TrayStatus } from './tray-menu';
import { trayAvailable, type RunCommand } from './tray-support';
import { trayText, type TrayLang, type TrayTextKey } from './tray-text';

/**
 * Electron main: only the shell. It starts the core as a utility process, opens the window on the
 * core's loopback URL, offers the few native things the renderer cannot do (dialogs, secrets), and
 * keeps LLM Bench in the tray while servers run (tray menu, close-to-tray, start at login).
 * Electron and the host process are injected (index.ts passes the real ones) so this is unit-testable.
 */

/** The parts of an Electron Tray the shell uses. */
export interface TrayLike {
  setImage(image: NativeImage): void;
  setToolTip(text: string): void;
  setContextMenu(menu: MenuType): void;
  on(ev: 'click', fn: () => void): unknown;
  destroy(): void;
}

export interface ElectronApi {
  app: Pick<
    App,
    | 'setPath'
    | 'getPath'
    | 'isPackaged'
    | 'requestSingleInstanceLock'
    | 'quit'
    | 'exit'
    | 'relaunch'
    | 'whenReady'
    | 'on'
    | 'getLoginItemSettings'
    | 'setLoginItemSettings'
  >;
  BrowserWindow: new (opts: BrowserWindowConstructorOptions) => BrowserWindowType;
  dialog: Pick<Dialog, 'showOpenDialog' | 'showSaveDialog' | 'showErrorBox' | 'showMessageBox'>;
  ipcMain: Pick<IpcMain, 'handle'>;
  nativeTheme: Pick<NativeTheme, 'shouldUseDarkColors'>;
  safeStorage: Pick<SafeStorage, 'isEncryptionAvailable' | 'encryptString' | 'decryptString' | 'getSelectedStorageBackend'>;
  shell: Pick<Shell, 'openExternal' | 'showItemInFolder'>;
  utilityProcess: { fork(modulePath: string, args: string[], opts: Record<string, unknown>): UtilityProcess };
  Tray: new (image: NativeImage) => TrayLike;
  Menu: { buildFromTemplate(template: MenuItemConstructorOptions[]): MenuType };
  nativeImage: { createFromPath(p: string): NativeImage };
  Notification: { new (o: { title: string; body: string; icon?: string }): { show(): void }; isSupported(): boolean };
  clipboard: { writeText(text: string): void };
}

export interface ShellFs {
  readFile(p: string): Promise<Buffer>;
  writeFile(p: string, data: string | Buffer, opts?: unknown): Promise<void>;
  mkdir(p: string, opts: { recursive: true }): Promise<unknown>;
  rm(p: string, opts: { force: true }): Promise<void>;
}

export interface ShellHost {
  env: NodeJS.ProcessEnv;
  platform: string;
  /** Command line of this process ("--hidden" when started at login). */
  argv: readonly string[];
  /** Folder of the main bundle (out/main). */
  dirname: string;
  resourcesPath: string;
  home: string;
  /** The Electron executable (the login item starts it). */
  execPath: string;
  fs: ShellFs;
  /** Small programs (the Linux tray check). */
  run: RunCommand;
  /** Forwards the core's output to our own stdout/stderr. */
  write(stream: 'stdout' | 'stderr', d: Buffer): void;
  takeCoverage(): void;
  /** Puts a value on the main process's global object (the E2E test hook, GPUBENCH_TEST_HOOKS=1 only). */
  expose(name: string, value: unknown): void;
  /** Grace period before the core is killed at quit (default 4 s, 20 s while servers run). */
  shutdownTimeoutMs?: number;
  /**
   * Taking over GPU Bench's data (migrate.ts): node:fs itself (sync and promises), the host name and
   * process.kill. Absent: no migration.
   */
  legacy?: { sync: LegacySyncFs; async: LegacyAsyncFs; hostname: string; kill(pid: number, signal: 0): unknown };
}

export const TITLEBAR_HEIGHT = 40;
export const MAX_SAVE_BYTES = 64 * 1024 * 1024;
/** Time the core gets to stop our servers (containers included) when LLM Bench quits with servers running. */
export const SHUTDOWN_WITH_SERVERS_MS = 20_000;
export const SHUTDOWN_MS = 4000;

export function titleBarColors(dark: boolean): { color: string; symbolColor: string } {
  return dark ? { color: '#0b0d12', symbolColor: '#e6e8ee' } : { color: '#f4f5f8', symbolColor: '#1b1f2a' };
}

/** index.ts's `expose`: a property of the main process's global object. */
export function exposeOnGlobal(name: string, value: unknown): void {
  (globalThis as Record<string, unknown>)[name] = value;
}

/** The tray menu as an Electron template; every item with a command runs it. */
export function menuTemplate(items: readonly TrayItem[], run: (c: TrayCommand) => void): MenuItemConstructorOptions[] {
  return items.map((i): MenuItemConstructorOptions => {
    if (i.type === 'separator') return { type: 'separator' };
    const command = i.command;
    return {
      label: i.label as string,
      ...(i.enabled === false ? { enabled: false } : {}),
      ...(i.submenu ? { submenu: menuTemplate(i.submenu, run) } : {}),
      ...(command ? { click: () => run(command) } : {}),
    };
  });
}

/** What the E2E tests reach through `__gpubench` (Playwright cannot click the OS tray). */
export interface ShellTestHooks {
  trayMenu(): string[];
  trayStatus(): TrayStatus | undefined;
  trayTooltip(): string | undefined;
  /** Runs the tray item at `path` (labels, see findCommand); false when there is none. */
  clickTray(...path: string[]): boolean;
  closeWindow(): void;
  windowState(): { visible: boolean; minimized: boolean; destroyed: boolean } | undefined;
  /** The answer the "Esci" confirmation gets instead of the native dialog. */
  answerQuit(yes: boolean): void;
  notifications(): { title: string; body: string }[];
}

export interface ShellState {
  token: string;
  corePort: number;
  core: UtilityProcess | undefined;
  window: BrowserWindowType | undefined;
  quitting: boolean;
  /** What the core says runs (servers, presets, close behaviour, language). */
  app: CoreState | undefined;
  tray: TrayLike | undefined;
  trayItems: TrayItem[];
  trayIcon: TrayStatus | undefined;
  /** The one-time "resta attivo nell'area di notifica" was shown (shell.json). */
  hideNoticeShown: boolean;
  /** The login item as last asked by settings (applied once per change). */
  loginWanted: boolean | undefined;
  notifications: { title: string; body: string }[];
  quitAnswer: boolean | undefined;
}

export function startShell(e: ElectronApi, h: ShellHost): ShellState {
  const { app } = e;
  if (h.env.GPUBENCH_USER_DATA) app.setPath('userData', h.env.GPUBENCH_USER_DATA);
  // GPU Bench's folder sits next to ours; tests name one (GPUBENCH_LEGACY_USER_DATA) or have none.
  const legacyDir = h.env.GPUBENCH_LEGACY_USER_DATA || (h.env.GPUBENCH_USER_DATA ? undefined : path.join(path.dirname(app.getPath('userData')), LEGACY_APP_NAME));
  // First thing, before the lock file and Chromium's own files land in the new folder (migrate.ts).
  const move: LegacyMove =
    h.legacy && legacyDir
      ? moveLegacyData({ platform: h.platform, userData: app.getPath('userData'), legacy: legacyDir, fs: h.legacy.sync, hostname: h.legacy.hostname, kill: h.legacy.kill })
      : { kind: 'none' };
  const s: ShellState = {
    token: randomBytes(24).toString('base64url'),
    corePort: 0,
    core: undefined,
    window: undefined,
    quitting: false,
    app: undefined,
    tray: undefined,
    trayItems: [],
    trayIcon: undefined,
    hideNoticeShown: false,
    loginWanted: undefined,
    notifications: [],
    quitAnswer: undefined,
  };
  const dataDir = () => app.getPath('userData');
  const tokenFile = () => path.join(dataDir(), 'hf-token.bin');
  const serverKeyFile = () => path.join(dataDir(), 'server-api-key.bin');
  const prefsFile = () => path.join(dataDir(), 'shell.json');
  const resources = () => (app.isPackaged ? path.join(h.resourcesPath, 'app-resources') : path.resolve(h.dirname, '../../resources'));
  const appIcon = () => path.join(resources(), 'icons', 'icon.png');
  // Until the core tells (the first moments after start-up): English, the app's default language.
  const lang = (): TrayLang => s.app?.language ?? 'en';
  const t = (k: TrayTextKey, p?: Record<string, string | number>) => trayText(lang(), k, p);
  const warn = (msg: string) => h.write('stderr', Buffer.from(`${msg}\n`));

  /**
   * Secrets are encrypted whenever the OS offers it; Linux without a keyring falls back to a key
   * Electron ships ("basic_text"): that is as good as plain text, and the UI says so.
   */
  const secureStorage = () => e.safeStorage.isEncryptionAvailable() && !(h.platform === 'linux' && e.safeStorage.getSelectedStorageBackend() === 'basic_text');

  /**
   * A saved secret. One that is there but cannot be decrypted any more (Linux: the keyring entry
   * follows the app's name, so after the rename) is removed, and the window asks for it again.
   */
  async function readSecret(file: string, secret: 'hf-token' | 'server-api-key', notices: AppNotice[]): Promise<string | undefined> {
    const buf = await h.fs.readFile(file).catch(() => undefined);
    if (buf === undefined) return undefined;
    if (!e.safeStorage.isEncryptionAvailable()) return buf.toString('utf8');
    try {
      return e.safeStorage.decryptString(buf);
    } catch {
      await h.fs.rm(file, { force: true }).catch((err: unknown) => warn(`unreadable secret not removed: ${String(err)}`));
      notices.push({ id: `secret-unreadable:${secret}`, kind: 'secret-unreadable', secret, renamed: move.kind !== 'none' });
      return undefined;
    }
  }

  /** Saves a secret (encrypted when possible, readable only by this user); true = really protected. */
  async function writeSecret(file: string, value: string): Promise<boolean> {
    const data = e.safeStorage.isEncryptionAvailable() ? e.safeStorage.encryptString(value) : Buffer.from(value, 'utf8');
    await h.fs.mkdir(dataDir(), { recursive: true });
    await h.fs.writeFile(file, data, { mode: 0o600 });
    return secureStorage();
  }

  /** An OS notification; under the E2E test hooks only recorded (no toasts on the desktop of whoever runs the tests). */
  function notify(title: string, body: string): void {
    s.notifications.push({ title, body });
    if (h.env.GPUBENCH_TEST_HOOKS !== '1' && e.Notification.isSupported()) new e.Notification({ title, body, icon: appIcon() }).show();
  }

  function showWindow(): void {
    const win = s.window;
    if (!win) return;
    if (!win.isVisible()) win.show();
    if (win.isMinimized()) win.restore();
    win.focus();
  }

  async function requestQuit(): Promise<void> {
    const n = s.app?.servers.length ?? 0;
    if (n > 0) {
      const yes =
        s.quitAnswer ??
        (
          await e.dialog.showMessageBox({
            type: 'question',
            title: t('quitTitle'),
            message: t('quitTitle'),
            detail: n === 1 ? t('quitOne') : t('quitMany', { n }),
            buttons: [t('quitConfirm'), t('quitCancel')],
            defaultId: 0,
            cancelId: 1,
            noLink: true,
          })
        ).response === 0;
      if (!yes) return;
    }
    app.quit();
  }

  function runTrayCommand(c: TrayCommand): void {
    if (c.kind === 'open') showWindow();
    else if (c.kind === 'copy') e.clipboard.writeText(c.url);
    else if (c.kind === 'quit') void requestQuit();
    else if (c.kind === 'stop-all' || c.kind === 'docker-start' || c.kind === 'docker-restart') s.core?.postMessage({ type: 'tray', action: c.kind });
    else s.core?.postMessage({ type: 'tray', action: c.kind, id: c.id });
  }

  function trayIconFile(status: TrayStatus): string {
    return path.join(resources(), 'icons', 'tray', h.platform === 'linux' ? `${status}-linux.png` : `${status}.png`);
  }

  function refreshTray(): void {
    const tray = s.tray;
    if (!tray) return;
    s.trayItems = trayMenu(s.app, lang());
    tray.setContextMenu(e.Menu.buildFromTemplate(menuTemplate(s.trayItems, runTrayCommand)));
    tray.setToolTip(trayTooltip(s.app, lang()));
    const status = trayStatus(s.app);
    if (status !== s.trayIcon) {
      s.trayIcon = status;
      tray.setImage(e.nativeImage.createFromPath(trayIconFile(status)));
    }
  }

  const loginHost: LoginItemHost = {
    platform: h.platform,
    env: h.env,
    home: h.home,
    execPath: h.execPath,
    ...(app.isPackaged ? {} : { appPath: path.resolve(h.dirname, '../..') }),
    fs: h.fs,
    getLoginItemSettings: (o) => app.getLoginItemSettings(o),
    setLoginItemSettings: (o) => app.setLoginItemSettings(o),
    run: h.run,
  };

  /** "Avvia LLM Bench all'accesso": the OS entry follows the setting (only touched when they differ). */
  async function syncLoginItem(wanted: boolean): Promise<void> {
    if (s.loginWanted === wanted) return;
    s.loginWanted = wanted;
    try {
      if ((await loginItemEnabled(loginHost)) !== wanted) await setLoginItem(loginHost, wanted);
    } catch (err) {
      h.write('stderr', Buffer.from(`login item not changed: ${String(err)}\n`));
    }
  }

  async function saveServerKey(key: string): Promise<void> {
    const secure = await writeSecret(serverKeyFile(), key);
    s.core?.postMessage({ type: 'server-api-key', key, storage: secure ? 'encrypted' : 'plain' });
  }

  function onCoreMessage(msg: { type?: string; port?: number; state?: unknown; notice?: { kind?: unknown; name?: unknown }; key?: unknown } | null): void {
    if (msg?.type === 'shell-state') {
      const parsed = shellStateSchema.safeParse(msg.state);
      if (!parsed.success) return;
      s.app = parsed.data;
      refreshTray();
      void syncLoginItem(parsed.data.launchAtLogin);
    } else if (msg?.type === 'shell-notice' && msg.notice?.kind === 'docker-stuck') {
      notify(t('dockerStuckTitle'), t('dockerStuckBody'));
    } else if (msg?.type === 'shell-notice' && typeof msg.notice?.name === 'string') {
      notify(t('startFailedTitle'), t('startFailedBody', { name: msg.notice.name }));
    } else if (msg?.type === 'server-api-key-save' && typeof msg.key === 'string') {
      void saveServerKey(msg.key);
    }
  }

  /** Starts the core; once it is ready it gets the saved secrets (read before: they may have been unreadable). */
  function startCore(secrets: { token: string | undefined; key: string | undefined }): Promise<number> {
    return new Promise((resolve, reject) => {
      const proc = e.utilityProcess.fork(path.join(h.dirname, '../core/index.cjs'), [], {
        serviceName: `${APP_NAME} Core`,
        stdio: 'pipe',
        env: {
          ...h.env,
          GPUBENCH_TOKEN: s.token,
          GPUBENCH_DATA_DIR: dataDir(),
          GPUBENCH_RESOURCES_DIR: resources(),
          GPUBENCH_UI_DIR: path.join(h.dirname, '../renderer'),
        },
      });
      s.core = proc;
      proc.stdout?.on('data', (d: Buffer) => h.write('stdout', d));
      proc.stderr?.on('data', (d: Buffer) => h.write('stderr', d));
      proc.on('message', (msg: { type?: string; port?: number } | null) => {
        if (msg?.type === 'ready' && typeof msg.port === 'number') {
          // The saved secrets first, then the presets marked "Avvia all'apertura" (they may need the key).
          proc.postMessage({ type: 'hf-token', token: secrets.token ?? null });
          if (secrets.key) proc.postMessage({ type: 'server-api-key', key: secrets.key, storage: secureStorage() ? 'encrypted' : 'plain' });
          proc.postMessage({ type: 'autostart' });
          resolve(msg.port);
        } else onCoreMessage(msg);
      });
      proc.on('exit', (code) => {
        s.core = undefined;
        if (s.quitting) return;
        if (s.corePort === 0) {
          reject(new Error(`core exited with code ${code}`));
          return;
        }
        e.dialog.showErrorBox(APP_NAME, t('coreCrashed', { code: String(code) }));
        app.relaunch();
        app.exit(1);
      });
    });
  }

  async function createWindow(): Promise<void> {
    const dark = e.nativeTheme.shouldUseDarkColors;
    const win = new e.BrowserWindow({
      width: 1360,
      height: 880,
      minWidth: 1024,
      minHeight: 680,
      show: false,
      title: APP_NAME,
      backgroundColor: titleBarColors(dark).color,
      titleBarStyle: 'hidden',
      titleBarOverlay: { ...titleBarColors(dark), height: TITLEBAR_HEIGHT },
      icon: appIcon(),
      webPreferences: {
        preload: path.join(h.dirname, '../preload/index.cjs'),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        spellcheck: false,
      },
    });
    s.window = win;
    const origin = `http://127.0.0.1:${s.corePort}/`;
    // Never navigate away from the core, never open new windows inside the app.
    win.webContents.on('will-navigate', (ev, url) => {
      if (!url.startsWith(origin)) ev.preventDefault();
    });
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https:\/\//.test(url)) void e.shell.openExternal(url);
      return { action: 'deny' };
    });
    // Closing the window while a server runs keeps LLM Bench in the tray ("Alla chiusura della finestra").
    win.on('close', (ev) => {
      const servers = s.app?.servers.length ?? 0;
      const action = closeAction({ quitting: s.quitting, behavior: s.app?.closeBehavior ?? 'tray-if-servers', servers, tray: s.tray !== undefined });
      if (action === 'quit') return;
      ev.preventDefault();
      if (action === 'minimize') {
        win.minimize();
        return;
      }
      win.hide();
      if (shouldExplainHide(action, s.hideNoticeShown)) {
        s.hideNoticeShown = true;
        notify(t('hiddenTitle'), servers ? t('hiddenBody') : t('hiddenBodyAlways'));
        void h.fs.writeFile(prefsFile(), JSON.stringify({ hideNoticeShown: true })).catch(() => undefined);
      }
    });
    win.once('ready-to-show', () => {
      if (h.env.GPUBENCH_HIDE_WINDOW) return;
      // Started at login: straight to the tray (or minimized where there is none).
      const how = startupWindow({ hiddenStart: h.argv.includes(HIDDEN_ARG), tray: s.tray !== undefined });
      if (how === 'show') win.show();
      else if (how === 'minimize') win.minimize();
    });
    await win.loadURL(origin);
  }

  function registerIpc(): void {
    const { ipcMain, dialog, shell } = e;
    ipcMain.handle('gpubench:connection', () => ({ baseUrl: `http://127.0.0.1:${s.corePort}`, token: s.token }));
    ipcMain.handle('gpubench:pick-file', async (_ev, opts?: { title?: string; filters?: FileFilter[] }) => {
      const r = await dialog.showOpenDialog(s.window!, { properties: ['openFile'], ...(opts?.title ? { title: opts.title } : {}), ...(opts?.filters ? { filters: opts.filters } : {}) });
      return r.canceled ? null : (r.filePaths[0] ?? null);
    });
    ipcMain.handle('gpubench:pick-folder', async (_ev, opts?: { title?: string }) => {
      const r = await dialog.showOpenDialog(s.window!, { properties: ['openDirectory', 'createDirectory'], ...(opts?.title ? { title: opts.title } : {}) });
      return r.canceled ? null : (r.filePaths[0] ?? null);
    });
    ipcMain.handle('gpubench:open-external', async (_ev, url: unknown) => {
      if (typeof url === 'string' && /^https:\/\//.test(url)) await shell.openExternal(url);
    });
    ipcMain.handle('gpubench:reveal', (_ev, p: unknown) => {
      if (typeof p === 'string' && p) shell.showItemInFolder(p);
    });
    ipcMain.handle('gpubench:titlebar-theme', (_ev, theme: { background: string; symbols: string }) => {
      // Only Windows draws the native window buttons on our title bar.
      if (s.window && h.platform === 'win32') s.window.setTitleBarOverlay({ color: theme.background, symbolColor: theme.symbols, height: TITLEBAR_HEIGHT });
    });
    ipcMain.handle('gpubench:hf-token-save', async (_ev, value: unknown) => {
      if (typeof value !== 'string' || value.length > 512) return { ok: false, secure: false };
      const secure = await writeSecret(tokenFile(), value);
      s.core?.postMessage({ type: 'hf-token', token: value });
      return { ok: true, secure };
    });
    ipcMain.handle('gpubench:hf-token-clear', async () => {
      await h.fs.rm(tokenFile(), { force: true });
      s.core?.postMessage({ type: 'hf-token', token: null });
    });
    ipcMain.handle('gpubench:save-file', async (_ev, opts: { defaultName?: unknown; content?: unknown; filters?: FileFilter[] } | undefined) => {
      if (typeof opts?.defaultName !== 'string' || typeof opts.content !== 'string' || opts.content.length > MAX_SAVE_BYTES) return null;
      const r = await dialog.showSaveDialog(s.window!, {
        defaultPath: path.join(app.getPath('documents'), path.basename(opts.defaultName)),
        ...(Array.isArray(opts.filters) ? { filters: opts.filters } : {}),
      });
      if (r.canceled || !r.filePath) return null;
      await h.fs.writeFile(r.filePath, opts.content, 'utf8');
      return r.filePath;
    });
    // Settings → "Alla chiusura della finestra": whether this desktop has a tray at all.
    ipcMain.handle('gpubench:shell-info', () => ({ tray: s.tray !== undefined }));
  }

  function exposeTestHooks(): void {
    const hooks: ShellTestHooks = {
      trayMenu: () => menuLines(s.trayItems),
      trayStatus: () => s.trayIcon,
      trayTooltip: () => (s.tray ? trayTooltip(s.app, lang()) : undefined),
      clickTray: (...p) => {
        const c = findCommand(s.trayItems, p);
        if (c) runTrayCommand(c);
        return c !== undefined;
      },
      closeWindow: () => s.window?.close(),
      windowState: () => (s.window ? { visible: s.window.isVisible(), minimized: s.window.isMinimized(), destroyed: s.window.isDestroyed() } : undefined),
      answerQuit: (yes) => {
        s.quitAnswer = yes;
      },
      notifications: () => [...s.notifications],
    };
    h.expose('__gpubench', hooks);
  }

  function shutdownCore(): Promise<void> {
    const proc = s.core;
    if (!proc) return Promise.resolve();
    const grace = h.shutdownTimeoutMs ?? (s.app?.servers.length ? SHUTDOWN_WITH_SERVERS_MS : SHUTDOWN_MS);
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        proc.kill();
        resolve();
      }, grace);
      proc.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
      proc.postMessage({ type: 'shutdown' });
    });
  }

  if (!app.requestSingleInstanceLock()) {
    // Another LLM Bench is already open: it gets focused (second-instance) and this one leaves.
    app.quit();
    return s;
  }

  // Launching LLM Bench again brings the window back, from the tray too.
  app.on('second-instance', showWindow);

  if (h.env.GPUBENCH_TEST_HOOKS === '1') exposeTestHooks();

  void app.whenReady().then(async () => {
    registerIpc();
    const prefs = h.fs.readFile(prefsFile()).then(
      (b): { hideNoticeShown?: unknown } => {
        try {
          return JSON.parse(String(b)) as { hideNoticeShown?: unknown };
        } catch {
          return {};
        }
      },
      (): { hideNoticeShown?: unknown } => ({}),
    );
    const hasTray = trayAvailable({ platform: h.platform, env: h.env, run: h.run });
    // GPU Bench's data taken over: the copy (when its folder could not be renamed), the paths that
    // follow it and the start at login, before the core reads any of it; the window says it once.
    const notices: AppNotice[] = [];
    if (move.kind !== 'none') {
      notices.push(movedNotice(move, await finishLegacyMove({ platform: h.platform, fs: (h.legacy as NonNullable<ShellHost['legacy']>).async, warn }, move)));
      await migrateLegacyLoginItem(loginHost).catch((err: unknown) => warn(`login item not moved: ${String(err)}`));
    }
    const secrets = { token: await readSecret(tokenFile(), 'hf-token', notices), key: await readSecret(serverKeyFile(), 'server-api-key', notices) };
    await addAppNotices(h.fs, dataDir(), notices).catch((err: unknown) => warn(`notices not saved: ${String(err)}`));
    try {
      s.corePort = await startCore(secrets);
    } catch (err) {
      // startCore() only rejects with an Error (the core exited before saying it was ready).
      e.dialog.showErrorBox(APP_NAME, t('startFailed', { error: (err as Error).message }));
      app.exit(1);
      return;
    }
    s.hideNoticeShown = (await prefs).hideNoticeShown === true;
    if (await hasTray) {
      s.tray = new e.Tray(e.nativeImage.createFromPath(trayIconFile('idle')));
      s.trayIcon = 'idle';
      // Windows: a click on the icon opens the window (Linux panels open the menu instead).
      s.tray.on('click', showWindow);
      refreshTray();
    }
    await createWindow();
  });

  app.on('before-quit', (ev) => {
    if (s.quitting) return;
    s.quitting = true;
    ev.preventDefault();
    void shutdownCore().then(() => {
      s.tray?.destroy();
      if (h.env.NODE_V8_COVERAGE) h.takeCoverage();
      app.quit();
    });
  });

  app.on('window-all-closed', () => app.quit());
  return s;
}
