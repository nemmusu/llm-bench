import type {
  App,
  BrowserWindow as BrowserWindowType,
  BrowserWindowConstructorOptions,
  Dialog,
  FileFilter,
  IpcMain,
  NativeTheme,
  SafeStorage,
  Shell,
  UtilityProcess,
} from 'electron';
import { randomBytes } from 'node:crypto';
import path from 'node:path';

/**
 * Electron main: only the shell. It starts the core as a utility process, opens the window on the
 * core's loopback URL and offers the few native things the renderer cannot do (dialogs, secrets).
 * Electron and the host process are injected (index.ts passes the real ones) so this is unit-testable.
 */

export interface ElectronApi {
  app: Pick<
    App,
    'setPath' | 'getPath' | 'isPackaged' | 'requestSingleInstanceLock' | 'quit' | 'exit' | 'relaunch' | 'whenReady' | 'on'
  >;
  BrowserWindow: new (opts: BrowserWindowConstructorOptions) => BrowserWindowType;
  dialog: Pick<Dialog, 'showOpenDialog' | 'showSaveDialog' | 'showErrorBox'>;
  ipcMain: Pick<IpcMain, 'handle'>;
  nativeTheme: Pick<NativeTheme, 'shouldUseDarkColors'>;
  safeStorage: Pick<SafeStorage, 'isEncryptionAvailable' | 'encryptString' | 'decryptString'>;
  shell: Pick<Shell, 'openExternal' | 'showItemInFolder'>;
  utilityProcess: { fork(modulePath: string, args: string[], opts: Record<string, unknown>): UtilityProcess };
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
  /** Folder of the main bundle (out/main). */
  dirname: string;
  resourcesPath: string;
  fs: ShellFs;
  /** Forwards the core's output to our own stdout/stderr. */
  write(stream: 'stdout' | 'stderr', d: Buffer): void;
  takeCoverage(): void;
  /** Grace period before the core is killed at quit. */
  shutdownTimeoutMs?: number;
}

export const TITLEBAR_HEIGHT = 40;
export const MAX_SAVE_BYTES = 64 * 1024 * 1024;

export function titleBarColors(dark: boolean): { color: string; symbolColor: string } {
  return dark ? { color: '#0b0d12', symbolColor: '#e6e8ee' } : { color: '#f4f5f8', symbolColor: '#1b1f2a' };
}

export interface ShellState {
  token: string;
  corePort: number;
  core: UtilityProcess | undefined;
  window: BrowserWindowType | undefined;
  quitting: boolean;
}

export function startShell(e: ElectronApi, h: ShellHost): ShellState {
  const { app } = e;
  if (h.env.GPUBENCH_USER_DATA) app.setPath('userData', h.env.GPUBENCH_USER_DATA);
  const s: ShellState = { token: randomBytes(24).toString('base64url'), corePort: 0, core: undefined, window: undefined, quitting: false };
  const dataDir = () => app.getPath('userData');
  const tokenFile = () => path.join(dataDir(), 'hf-token.bin');

  async function readHfToken(): Promise<string | undefined> {
    try {
      const buf = await h.fs.readFile(tokenFile());
      return e.safeStorage.isEncryptionAvailable() ? e.safeStorage.decryptString(buf) : buf.toString('utf8');
    } catch {
      return undefined;
    }
  }

  function startCore(): Promise<number> {
    const resources = app.isPackaged ? path.join(h.resourcesPath, 'app-resources') : path.resolve(h.dirname, '../../resources');
    return new Promise((resolve, reject) => {
      const proc = e.utilityProcess.fork(path.join(h.dirname, '../core/index.cjs'), [], {
        serviceName: 'GPU Bench Core',
        stdio: 'pipe',
        env: {
          ...h.env,
          GPUBENCH_TOKEN: s.token,
          GPUBENCH_DATA_DIR: dataDir(),
          GPUBENCH_RESOURCES_DIR: resources,
          GPUBENCH_UI_DIR: path.join(h.dirname, '../renderer'),
        },
      });
      s.core = proc;
      proc.stdout?.on('data', (d: Buffer) => h.write('stdout', d));
      proc.stderr?.on('data', (d: Buffer) => h.write('stderr', d));
      proc.on('message', (msg: { type?: string; port?: number } | null) => {
        if (msg?.type === 'ready' && typeof msg.port === 'number') {
          void readHfToken().then((t) => proc.postMessage({ type: 'hf-token', token: t ?? null }));
          resolve(msg.port);
        }
      });
      proc.on('exit', (code) => {
        s.core = undefined;
        if (s.quitting) return;
        if (s.corePort === 0) {
          reject(new Error(`core exited with code ${code}`));
          return;
        }
        e.dialog.showErrorBox('GPU Bench', `Il motore interno si è chiuso in modo inatteso (codice ${code}). L'app verrà riavviata.`);
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
      title: 'GPU Bench',
      backgroundColor: titleBarColors(dark).color,
      titleBarStyle: 'hidden',
      titleBarOverlay: { ...titleBarColors(dark), height: TITLEBAR_HEIGHT },
      icon: app.isPackaged ? path.join(h.resourcesPath, 'app-resources', 'icons', 'icon.png') : path.resolve(h.dirname, '../../resources/icons/icon.png'),
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
    win.once('ready-to-show', () => {
      if (!h.env.GPUBENCH_HIDE_WINDOW) win.show();
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
    ipcMain.handle('gpubench:titlebar-theme', (_ev, t: { background: string; symbols: string }) => {
      // Only Windows draws the native window buttons on our title bar.
      if (s.window && h.platform === 'win32') s.window.setTitleBarOverlay({ color: t.background, symbolColor: t.symbols, height: TITLEBAR_HEIGHT });
    });
    ipcMain.handle('gpubench:hf-token-save', async (_ev, value: unknown) => {
      if (typeof value !== 'string' || value.length > 512) return { ok: false, secure: false };
      const secure = e.safeStorage.isEncryptionAvailable();
      const data = secure ? e.safeStorage.encryptString(value) : Buffer.from(value, 'utf8');
      await h.fs.mkdir(dataDir(), { recursive: true });
      await h.fs.writeFile(tokenFile(), data, { mode: 0o600 });
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
  }

  function shutdownCore(): Promise<void> {
    const proc = s.core;
    if (!proc) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        proc.kill();
        resolve();
      }, h.shutdownTimeoutMs ?? 4000);
      proc.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
      proc.postMessage({ type: 'shutdown' });
    });
  }

  if (!app.requestSingleInstanceLock()) {
    // Another GPU Bench is already open: it gets focused (second-instance) and this one leaves.
    app.quit();
    return s;
  }

  app.on('second-instance', () => {
    const win = s.window;
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });

  void app.whenReady().then(async () => {
    registerIpc();
    try {
      s.corePort = await startCore();
    } catch (err) {
      // startCore() only rejects with an Error (the core exited before saying it was ready).
      e.dialog.showErrorBox('GPU Bench', `Impossibile avviare GPU Bench: ${(err as Error).message}`);
      app.exit(1);
      return;
    }
    await createWindow();
  });

  app.on('before-quit', (ev) => {
    if (s.quitting) return;
    s.quitting = true;
    ev.preventDefault();
    void shutdownCore().then(() => {
      if (h.env.NODE_V8_COVERAGE) h.takeCoverage();
      app.quit();
    });
  });

  app.on('window-all-closed', () => app.quit());
  return s;
}
