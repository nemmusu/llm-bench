import { app, BrowserWindow, dialog, ipcMain, nativeTheme, safeStorage, shell, utilityProcess, type UtilityProcess } from 'electron';
import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import v8 from 'node:v8';

/**
 * Electron main: only the shell. It starts the core as a utility process, opens the window on the
 * core's loopback URL and offers the few native things the renderer cannot do (dialogs, secrets).
 */

const userDataOverride = process.env.GPUBENCH_USER_DATA;
if (userDataOverride) app.setPath('userData', userDataOverride);

const isWin = process.platform === 'win32';
const token = randomBytes(24).toString('base64url');
let core: UtilityProcess | undefined;
let corePort = 0;
let mainWindow: BrowserWindow | undefined;
let quitting = false;

const TITLEBAR_HEIGHT = 40;

function dataDir(): string {
  return app.getPath('userData');
}

async function readHfToken(): Promise<string | undefined> {
  try {
    const buf = await fs.readFile(path.join(dataDir(), 'hf-token.bin'));
    return safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(buf) : buf.toString('utf8');
  } catch {
    return undefined;
  }
}

function startCore(): Promise<number> {
  const resources = app.isPackaged ? process.resourcesPath : path.resolve(__dirname, '../../resources');
  return new Promise((resolve, reject) => {
    const proc = utilityProcess.fork(path.join(__dirname, '../core/index.cjs'), [], {
      serviceName: 'GPU Bench Core',
      stdio: 'pipe',
      env: {
        ...process.env,
        GPUBENCH_TOKEN: token,
        GPUBENCH_DATA_DIR: dataDir(),
        GPUBENCH_RESOURCES_DIR: path.join(resources, app.isPackaged ? 'app-resources' : ''),
        GPUBENCH_UI_DIR: path.join(__dirname, '../renderer'),
      },
    });
    core = proc;
    proc.stdout?.on('data', (d: Buffer) => process.stdout.write(d));
    proc.stderr?.on('data', (d: Buffer) => process.stderr.write(d));
    proc.on('message', (msg: { type?: string; port?: number }) => {
      if (msg?.type === 'ready' && typeof msg.port === 'number') {
        void readHfToken().then((t) => proc.postMessage({ type: 'hf-token', token: t ?? null }));
        resolve(msg.port);
      }
    });
    proc.on('exit', (code) => {
      core = undefined;
      if (!quitting) {
        if (corePort === 0) reject(new Error(`core exited with code ${code}`));
        else {
          dialog.showErrorBox('GPU Bench', `Il motore interno si è chiuso in modo inatteso (codice ${code}). L'app verrà riavviata.`);
          app.relaunch();
          app.exit(1);
        }
      }
    });
  });
}

function titleBarColors(): { color: string; symbolColor: string } {
  return nativeTheme.shouldUseDarkColors
    ? { color: '#0b0d12', symbolColor: '#e6e8ee' }
    : { color: '#f4f5f8', symbolColor: '#1b1f2a' };
}

async function createWindow(): Promise<void> {
  const win = new BrowserWindow({
    width: 1360,
    height: 880,
    minWidth: 1024,
    minHeight: 680,
    show: false,
    title: 'GPU Bench',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0b0d12' : '#f4f5f8',
    titleBarStyle: 'hidden',
    titleBarOverlay: { ...titleBarColors(), height: TITLEBAR_HEIGHT },
    icon: path.join(__dirname, '../../resources/icons/icon.png'),
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  mainWindow = win;
  // Never navigate away from the core, never open new windows inside the app.
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(`http://127.0.0.1:${corePort}/`)) e.preventDefault();
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.once('ready-to-show', () => {
    if (!process.env.GPUBENCH_HIDE_WINDOW) win.show();
  });
  await win.loadURL(`http://127.0.0.1:${corePort}/`);
}

function registerIpc(): void {
  ipcMain.handle('gpubench:connection', () => ({ baseUrl: `http://127.0.0.1:${corePort}`, token }));
  ipcMain.handle('gpubench:pick-file', async (_e, opts?: { title?: string; filters?: Electron.FileFilter[] }) => {
    const r = await dialog.showOpenDialog(mainWindow!, { title: opts?.title, properties: ['openFile'], filters: opts?.filters });
    return r.canceled ? null : (r.filePaths[0] ?? null);
  });
  ipcMain.handle('gpubench:pick-folder', async (_e, opts?: { title?: string }) => {
    const r = await dialog.showOpenDialog(mainWindow!, { title: opts?.title, properties: ['openDirectory', 'createDirectory'] });
    return r.canceled ? null : (r.filePaths[0] ?? null);
  });
  ipcMain.handle('gpubench:open-external', async (_e, url: string) => {
    if (typeof url === 'string' && /^https:\/\//.test(url)) await shell.openExternal(url);
  });
  ipcMain.handle('gpubench:reveal', (_e, p: string) => {
    if (typeof p === 'string' && p) shell.showItemInFolder(p);
  });
  ipcMain.handle('gpubench:titlebar-theme', (_e, t: { background: string; symbols: string }) => {
    if (mainWindow && isWin) mainWindow.setTitleBarOverlay({ color: t.background, symbolColor: t.symbols, height: TITLEBAR_HEIGHT });
  });
  ipcMain.handle('gpubench:hf-token-save', async (_e, value: string) => {
    if (typeof value !== 'string' || value.length > 512) return { ok: false, secure: false };
    const secure = safeStorage.isEncryptionAvailable();
    const data = secure ? safeStorage.encryptString(value) : Buffer.from(value, 'utf8');
    await fs.mkdir(dataDir(), { recursive: true });
    await fs.writeFile(path.join(dataDir(), 'hf-token.bin'), data, { mode: 0o600 });
    core?.postMessage({ type: 'hf-token', token: value });
    return { ok: true, secure };
  });
  ipcMain.handle(
    'gpubench:save-file',
    async (_e, opts: { defaultName?: unknown; content?: unknown; filters?: Electron.FileFilter[] }) => {
      if (typeof opts?.defaultName !== 'string' || typeof opts.content !== 'string' || opts.content.length > 64 * 1024 * 1024) return null;
      const r = await dialog.showSaveDialog(mainWindow!, {
        defaultPath: path.join(app.getPath('documents'), path.basename(opts.defaultName)),
        ...(Array.isArray(opts.filters) ? { filters: opts.filters } : {}),
      });
      if (r.canceled || !r.filePath) return null;
      await fs.writeFile(r.filePath, opts.content, 'utf8');
      return r.filePath;
    },
  );
  ipcMain.handle('gpubench:hf-token-clear', async () => {
    await fs.rm(path.join(dataDir(), 'hf-token.bin'), { force: true });
    core?.postMessage({ type: 'hf-token', token: null });
  });
}

async function shutdownCore(): Promise<void> {
  const proc = core;
  if (!proc) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      proc.kill();
      resolve();
    }, 4000);
    proc.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    proc.postMessage({ type: 'shutdown' });
  });
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    registerIpc();
    try {
      corePort = await startCore();
    } catch (e) {
      dialog.showErrorBox('GPU Bench', `Impossibile avviare GPU Bench: ${e instanceof Error ? e.message : String(e)}`);
      app.exit(1);
      return;
    }
    await createWindow();
  });

  app.on('before-quit', (e) => {
    if (quitting) return;
    quitting = true;
    e.preventDefault();
    void shutdownCore().then(() => {
      if (process.env.NODE_V8_COVERAGE) v8.takeCoverage();
      app.quit();
    });
  });

  app.on('window-all-closed', () => app.quit());
}
