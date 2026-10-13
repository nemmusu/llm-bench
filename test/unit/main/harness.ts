/** Fake Electron and host process for startShell (src/main/shell.ts): nothing here touches the real OS. */
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { expect, vi } from 'vitest';
import type { BrowserWindowConstructorOptions, MenuItemConstructorOptions } from 'electron';
import type { ShellState as CoreState } from '../../../src/contract/servers';
import { startShell, type ElectronApi, type ShellHost, type ShellTestHooks } from '../../../src/main/shell';
import type { CommandResult } from '../../../src/main/tray-support';

export type Handler = (...args: unknown[]) => unknown;

export class FakeProc extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  posted: unknown[] = [];
  killed = false;
  postMessage(m: unknown) {
    this.posted.push(m);
  }
  kill() {
    this.killed = true;
    return true;
  }
}

export class FakeWindow {
  static last: FakeWindow | undefined;
  opts: BrowserWindowConstructorOptions;
  events = new Map<string, Handler>();
  listeners = new Map<string, Handler>();
  wc = new Map<string, Handler>();
  openHandler: Handler | undefined;
  shown = 0;
  focused = 0;
  restored = 0;
  minimizedCount = 0;
  hidden = 0;
  visible = false;
  minimized = false;
  destroyed = false;
  overlay: unknown;
  loaded = '';
  webContents = {
    on: (ev: string, fn: Handler) => this.wc.set(ev, fn),
    setWindowOpenHandler: (fn: Handler) => (this.openHandler = fn),
  };
  constructor(opts: BrowserWindowConstructorOptions) {
    this.opts = opts;
    FakeWindow.last = this;
  }
  once(ev: string, fn: Handler) {
    this.events.set(ev, fn);
  }
  on(ev: string, fn: Handler) {
    this.listeners.set(ev, fn);
  }
  show() {
    this.shown++;
    this.visible = true;
  }
  hide() {
    this.hidden++;
    this.visible = false;
  }
  isVisible() {
    return this.visible;
  }
  isMinimized() {
    return this.minimized;
  }
  isDestroyed() {
    return this.destroyed;
  }
  minimize() {
    this.minimizedCount++;
    this.minimized = true;
  }
  restore() {
    this.restored++;
    this.minimized = false;
  }
  focus() {
    this.focused++;
  }
  /** Like the user clicking X: the 'close' listener may keep it (preventDefault). Returns whether it closed. */
  close() {
    let prevented = false;
    this.listeners.get('close')?.({ preventDefault: () => (prevented = true) });
    if (!prevented) this.destroyed = true;
    return !prevented;
  }
  setTitleBarOverlay(o: unknown) {
    this.overlay = o;
  }
  async loadURL(u: string) {
    this.loaded = u;
  }
}

export class FakeTray {
  static last: FakeTray | undefined;
  image: unknown;
  images: unknown[] = [];
  tooltip = '';
  menu: { template: MenuItemConstructorOptions[] } | undefined;
  handlers = new Map<string, Handler>();
  destroyed = false;
  constructor(image: unknown) {
    this.image = image;
    this.images.push(image);
    FakeTray.last = this;
  }
  setImage(i: unknown) {
    this.image = i;
    this.images.push(i);
  }
  setToolTip(t: string) {
    this.tooltip = t;
  }
  setContextMenu(m: { template: MenuItemConstructorOptions[] }) {
    this.menu = m;
  }
  on(ev: string, fn: Handler) {
    this.handlers.set(ev, fn);
  }
  destroy() {
    this.destroyed = true;
  }
  /** The menu item at `path` (labels), as Electron would click it. */
  click(...p: string[]) {
    let items = this.menu!.template;
    let hit: MenuItemConstructorOptions | undefined;
    for (const label of p) {
      hit = items.find((i) => i.label === label);
      items = (hit?.submenu as MenuItemConstructorOptions[] | undefined) ?? [];
    }
    (hit!.click as () => void)();
  }
  labels() {
    return this.menu!.template.map((i) => (i.type === 'separator' ? '---' : i.label));
  }
}

export interface WorldOptions {
  lock?: boolean;
  packaged?: boolean;
  dark?: boolean;
  secure?: boolean;
  backend?: string;
  tokenFile?: Buffer;
  keyFile?: Buffer;
  prefs?: string;
  platform?: string;
  env?: NodeJS.ProcessEnv;
  argv?: string[];
  timeoutMs?: number;
  notifications?: boolean;
  /** Answers of `run` (the Linux tray check). */
  run?: (cmd: string) => CommandResult;
  /** Index of the button the "Esci" dialog returns. */
  quitResponse?: number;
  loginEnabled?: boolean;
}

export function world(o: WorldOptions = {}) {
  const appEvents = new Map<string, Handler>();
  const handlers = new Map<string, Handler>();
  const files = new Map<string, Buffer | string>();
  if (o.tokenFile) files.set(path.join('/user', 'hf-token.bin'), o.tokenFile);
  if (o.keyFile) files.set(path.join('/user', 'server-api-key.bin'), o.keyFile);
  if (o.prefs) files.set(path.join('/user', 'shell.json'), o.prefs);
  const proc = new FakeProc();
  const forks: { modulePath: string; opts: Record<string, unknown> }[] = [];
  const errors: string[] = [];
  const shown: { title: string; body: string; icon?: string }[] = [];
  const boxes: { message: string; detail?: string; buttons?: string[] }[] = [];
  const clipboard: string[] = [];
  const login: { openAtLogin: boolean; path?: string; args?: string[] }[] = [];
  let loginEnabled = o.loginEnabled ?? false;
  const exposed: Record<string, unknown> = {};
  const calls = { quit: 0, exit: [] as number[], relaunch: 0, setPath: [] as string[][], openExternal: [] as string[], reveal: [] as string[] };
  let readyResolve!: () => void;
  const ready = new Promise<void>((r) => (readyResolve = r));
  const dialogs = { open: { canceled: false, filePaths: ['/picked'] } as { canceled: boolean; filePaths: string[] }, save: { canceled: false, filePath: '/saved.csv' } as { canceled: boolean; filePath?: string } };
  class FakeNotification {
    constructor(private readonly n: { title: string; body: string; icon?: string }) {}
    show() {
      shown.push(this.n);
    }
    static isSupported() {
      return o.notifications ?? true;
    }
  }
  const e: ElectronApi = {
    app: {
      setPath: (n: string, p: string) => void calls.setPath.push([n, p]),
      getPath: (n: string) => (n === 'userData' ? '/user' : '/docs'),
      isPackaged: o.packaged ?? false,
      requestSingleInstanceLock: () => o.lock ?? true,
      quit: () => void calls.quit++,
      exit: (c?: number) => void calls.exit.push(c ?? 0),
      relaunch: () => void calls.relaunch++,
      whenReady: () => ready,
      on: ((ev: string, fn: Handler) => appEvents.set(ev, fn)) as never,
      getLoginItemSettings: (() => ({ openAtLogin: loginEnabled })) as never,
      setLoginItemSettings: ((s: { openAtLogin: boolean }) => {
        login.push(s);
        loginEnabled = s.openAtLogin;
      }) as never,
    } as unknown as ElectronApi['app'],
    BrowserWindow: FakeWindow as unknown as ElectronApi['BrowserWindow'],
    dialog: {
      showOpenDialog: (async () => dialogs.open) as never,
      showSaveDialog: (async () => dialogs.save) as never,
      showErrorBox: (_t: string, m: string) => void errors.push(m),
      showMessageBox: (async (b: { message: string; detail?: string; buttons?: string[] }) => {
        boxes.push(b);
        return { response: o.quitResponse ?? 1, checkboxChecked: false };
      }) as never,
    },
    ipcMain: { handle: ((ch: string, fn: Handler) => handlers.set(ch, fn)) as never },
    nativeTheme: { shouldUseDarkColors: o.dark ?? false },
    safeStorage: {
      isEncryptionAvailable: () => o.secure ?? true,
      encryptString: (s: string) => Buffer.from(`enc:${s}`),
      decryptString: (b: Buffer) => b.toString().replace(/^enc:/, ''),
      getSelectedStorageBackend: (() => o.backend ?? 'gnome_libsecret') as never,
    },
    shell: {
      openExternal: (async (u: string) => void calls.openExternal.push(u)) as never,
      showItemInFolder: (p: string) => void calls.reveal.push(p),
    },
    utilityProcess: {
      fork: (modulePath, _args, opts) => {
        forks.push({ modulePath, opts });
        return proc as never;
      },
    },
    Tray: FakeTray as unknown as ElectronApi['Tray'],
    Menu: { buildFromTemplate: (template) => ({ template }) as never },
    nativeImage: { createFromPath: (p) => ({ path: p }) as never },
    Notification: FakeNotification as unknown as ElectronApi['Notification'],
    clipboard: { writeText: (t) => void clipboard.push(t) },
  };
  const out: Buffer[] = [];
  let coverage = 0;
  const h: ShellHost = {
    env: o.env ?? {},
    platform: o.platform ?? 'win32',
    argv: o.argv ?? ['electron', '.'],
    dirname: '/app/out/main',
    resourcesPath: '/res',
    home: '/home/anna',
    execPath: '/app/electron',
    fs: {
      readFile: async (p) => {
        const v = files.get(p);
        if (v === undefined) throw new Error('ENOENT');
        return Buffer.isBuffer(v) ? v : Buffer.from(v);
      },
      writeFile: async (p, d) => void files.set(p, d as Buffer),
      mkdir: async () => undefined,
      rm: async (p) => void files.delete(p),
    },
    run: async (cmd) => o.run?.(cmd) ?? { code: null, stdout: '' },
    write: (_stream, d) => void out.push(d),
    takeCoverage: () => void coverage++,
    expose: (name, value) => void (exposed[name] = value),
    shutdownTimeoutMs: o.timeoutMs ?? 50,
  };
  const invoke = (ch: string, ...args: unknown[]) => handlers.get(ch)!({}, ...args);
  return {
    e,
    h,
    appEvents,
    handlers,
    files,
    proc,
    forks,
    errors,
    calls,
    readyResolve,
    dialogs,
    out,
    invoke,
    shown,
    boxes,
    clipboard,
    login,
    hooks: () => exposed.__gpubench as ShellTestHooks,
    coverage: () => coverage,
  };
}

export const tick = () => new Promise((r) => setTimeout(r, 0));

/** The app started: core ready, window loaded (and the tray up when this desktop has one). */
export async function started(o: WorldOptions = {}) {
  FakeTray.last = undefined;
  FakeWindow.last = undefined;
  const w = world(o);
  const s = startShell(w.e, w.h);
  w.readyResolve();
  await tick();
  w.proc.emit('message', { type: 'ready', port: 4321 });
  await vi.waitFor(() => expect(FakeWindow.last?.loaded).toBe('http://127.0.0.1:4321/'));
  return { ...w, s, win: FakeWindow.last!, tray: FakeTray.last };
}

export function coreState(o: Partial<CoreState> = {}): CoreState {
  return { servers: [], presets: [], closeBehavior: 'tray-if-servers', launchAtLogin: false, language: 'it', ...o };
}

export const oneServer = coreState({
  servers: [{ id: 's1', modelName: 'Qwen3 8B', port: 8080, url: 'http://127.0.0.1:8080/v1', status: 'ready', network: 'local' }],
  presets: [{ id: 'p1', name: 'Codice', port: 8090, running: false }],
});
