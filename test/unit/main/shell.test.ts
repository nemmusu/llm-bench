import { EventEmitter } from 'node:events';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { BrowserWindowConstructorOptions } from 'electron';
import { MAX_SAVE_BYTES, startShell, titleBarColors, type ElectronApi, type ShellHost } from '../../../src/main/shell';

type Handler = (...args: unknown[]) => unknown;

class FakeProc extends EventEmitter {
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

class FakeWindow {
  static last: FakeWindow | undefined;
  opts: BrowserWindowConstructorOptions;
  events = new Map<string, Handler>();
  wc = new Map<string, Handler>();
  openHandler: Handler | undefined;
  shown = 0;
  focused = 0;
  restored = 0;
  minimized = false;
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
  show() {
    this.shown++;
  }
  isMinimized() {
    return this.minimized;
  }
  restore() {
    this.restored++;
  }
  focus() {
    this.focused++;
  }
  setTitleBarOverlay(o: unknown) {
    this.overlay = o;
  }
  async loadURL(u: string) {
    this.loaded = u;
  }
}

function world(o: { lock?: boolean; packaged?: boolean; dark?: boolean; secure?: boolean; tokenFile?: Buffer; platform?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}) {
  const appEvents = new Map<string, Handler>();
  const handlers = new Map<string, Handler>();
  const files = new Map<string, Buffer | string>();
  if (o.tokenFile) files.set(path.join('/user', 'hf-token.bin'), o.tokenFile);
  const proc = new FakeProc();
  const forks: { modulePath: string; opts: Record<string, unknown> }[] = [];
  const errors: string[] = [];
  const calls = { quit: 0, exit: [] as number[], relaunch: 0, setPath: [] as string[][], openExternal: [] as string[], reveal: [] as string[] };
  let readyResolve!: () => void;
  const ready = new Promise<void>((r) => (readyResolve = r));
  const dialogs = { open: { canceled: false, filePaths: ['/picked'] } as { canceled: boolean; filePaths: string[] }, save: { canceled: false, filePath: '/saved.csv' } as { canceled: boolean; filePath?: string } };
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
    } as unknown as ElectronApi['app'],
    BrowserWindow: FakeWindow as unknown as ElectronApi['BrowserWindow'],
    dialog: {
      showOpenDialog: (async () => dialogs.open) as never,
      showSaveDialog: (async () => dialogs.save) as never,
      showErrorBox: (_t: string, m: string) => void errors.push(m),
    },
    ipcMain: { handle: ((ch: string, fn: Handler) => handlers.set(ch, fn)) as never },
    nativeTheme: { shouldUseDarkColors: o.dark ?? false },
    safeStorage: {
      isEncryptionAvailable: () => o.secure ?? true,
      encryptString: (s: string) => Buffer.from(`enc:${s}`),
      decryptString: (b: Buffer) => b.toString().replace(/^enc:/, ''),
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
  };
  const out: Buffer[] = [];
  let coverage = 0;
  const h: ShellHost = {
    env: o.env ?? {},
    platform: o.platform ?? 'win32',
    dirname: '/app/out/main',
    resourcesPath: '/res',
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
    write: (_stream, d) => void out.push(d),
    takeCoverage: () => void coverage++,
    shutdownTimeoutMs: o.timeoutMs ?? 50,
  };
  const invoke = (ch: string, ...args: unknown[]) => handlers.get(ch)!({}, ...args);
  return { e, h, appEvents, handlers, files, proc, forks, errors, calls, readyResolve, dialogs, out, invoke, coverage: () => coverage };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

async function started(o: Parameters<typeof world>[0] = {}) {
  const w = world(o);
  const s = startShell(w.e, w.h);
  w.readyResolve();
  await tick();
  w.proc.emit('message', { type: 'ready', port: 4321 });
  await vi.waitFor(() => expect(FakeWindow.last?.loaded).toBe('http://127.0.0.1:4321/'));
  return { ...w, s, win: FakeWindow.last! };
}

describe('title bar colours', () => {
  it('match the renderer canvas in both themes', () => {
    expect(titleBarColors(true).color).toBe('#0b0d12');
    expect(titleBarColors(false).color).toBe('#f4f5f8');
  });
});

describe('startShell', () => {
  it('quits at once when another GPU Bench is already open', () => {
    const w = world({ lock: false, env: { GPUBENCH_USER_DATA: '/tmp/ud' } });
    const s = startShell(w.e, w.h);
    expect(w.calls.quit).toBe(1);
    expect(w.calls.setPath).toEqual([['userData', '/tmp/ud']]);
    expect(s.core).toBeUndefined();
  });

  it('starts the core, passes the HF token, opens the window on the core URL', async () => {
    const t = await started({ tokenFile: Buffer.from('enc:hf_saved') });
    const fork = t.forks[0]!;
    expect(fork.modulePath).toBe(path.join('/app/out/main', '../core/index.cjs'));
    expect(fork.opts.env).toMatchObject({ GPUBENCH_TOKEN: t.s.token, GPUBENCH_DATA_DIR: '/user', GPUBENCH_RESOURCES_DIR: path.resolve('/app/out/main', '../../resources') });
    await vi.waitFor(() => expect(t.proc.posted).toContainEqual({ type: 'hf-token', token: 'hf_saved' }));
    expect(t.win.opts).toMatchObject({ backgroundColor: '#f4f5f8', titleBarOverlay: { color: '#f4f5f8', height: 40 } });
    // Core output is forwarded; non-ready messages are ignored.
    t.proc.stdout.emit('data', Buffer.from('o'));
    t.proc.stderr.emit('data', Buffer.from('e'));
    t.proc.emit('message', { type: 'ready' });
    t.proc.emit('message', null);
    expect(t.out.map(String)).toEqual(['o', 'e']);
    // Shown when ready unless hidden for tests.
    t.win.events.get('ready-to-show')!();
    expect(t.win.shown).toBe(1);
  });

  it('packaged app: resources in app-resources, dark theme, hidden window for tests', async () => {
    const t = await started({ packaged: true, dark: true, secure: false, tokenFile: Buffer.from('plain_token'), env: { GPUBENCH_HIDE_WINDOW: '1' } });
    expect(t.forks[0]!.opts.env).toMatchObject({ GPUBENCH_RESOURCES_DIR: path.join('/res', 'app-resources') });
    expect(t.win.opts).toMatchObject({ backgroundColor: '#0b0d12', icon: path.join('/res', 'app-resources', 'icons', 'icon.png') });
    await vi.waitFor(() => expect(t.proc.posted).toContainEqual({ type: 'hf-token', token: 'plain_token' }));
    t.win.events.get('ready-to-show')!();
    expect(t.win.shown).toBe(0);
  });

  it('sends no token when none is saved', async () => {
    const t = await started();
    await vi.waitFor(() => expect(t.proc.posted).toContainEqual({ type: 'hf-token', token: null }));
  });

  it('keeps navigation inside the app and opens only https links outside', async () => {
    const t = await started();
    const prevented: string[] = [];
    const nav = t.win.wc.get('will-navigate')!;
    nav({ preventDefault: () => prevented.push('a') }, 'http://127.0.0.1:4321/#/results');
    nav({ preventDefault: () => prevented.push('b') }, 'https://evil.example/');
    expect(prevented).toEqual(['b']);
    expect(t.win.openHandler!({ url: 'https://huggingface.co/x' })).toEqual({ action: 'deny' });
    expect(t.win.openHandler!({ url: 'file:///etc/passwd' })).toEqual({ action: 'deny' });
    expect(t.calls.openExternal).toEqual(['https://huggingface.co/x']);
  });

  it('IPC: connection, pickers, links, reveal and title bar', async () => {
    const t = await started();
    expect(t.invoke('gpubench:connection')).toEqual({ baseUrl: 'http://127.0.0.1:4321', token: t.s.token });
    expect(await t.invoke('gpubench:pick-file', { title: 'Scegli', filters: [{ name: 'exe', extensions: ['exe'] }] })).toBe('/picked');
    expect(await t.invoke('gpubench:pick-file')).toBe('/picked');
    expect(await t.invoke('gpubench:pick-folder', { title: 'Cartella' })).toBe('/picked');
    expect(await t.invoke('gpubench:pick-folder')).toBe('/picked');
    t.dialogs.open = { canceled: true, filePaths: [] };
    expect(await t.invoke('gpubench:pick-file')).toBeNull();
    expect(await t.invoke('gpubench:pick-folder')).toBeNull();
    t.dialogs.open = { canceled: false, filePaths: [] };
    expect(await t.invoke('gpubench:pick-file')).toBeNull();
    expect(await t.invoke('gpubench:pick-folder')).toBeNull();
    await t.invoke('gpubench:open-external', 'https://nvidia.com/drivers');
    await t.invoke('gpubench:open-external', 'javascript:alert(1)');
    await t.invoke('gpubench:open-external', 42);
    expect(t.calls.openExternal).toEqual(['https://nvidia.com/drivers']);
    t.invoke('gpubench:reveal', 'C:\\models\\x.gguf');
    t.invoke('gpubench:reveal', '');
    t.invoke('gpubench:reveal', 7);
    expect(t.calls.reveal).toEqual(['C:\\models\\x.gguf']);
    t.invoke('gpubench:titlebar-theme', { background: '#000', symbols: '#fff' });
    expect(t.win.overlay).toEqual({ color: '#000', symbolColor: '#fff', height: 40 });
  });

  it('IPC: title bar colours only on Windows', async () => {
    const t = await started({ platform: 'linux' });
    t.invoke('gpubench:titlebar-theme', { background: '#000', symbols: '#fff' });
    expect(t.win.overlay).toBeUndefined();
  });

  it('IPC: HF token saved encrypted (or plain when the OS has no keyring) and cleared', async () => {
    const t = await started();
    expect(await t.invoke('gpubench:hf-token-save', 'hf_abc')).toEqual({ ok: true, secure: true });
    expect(String(t.files.get(path.join('/user', 'hf-token.bin')))).toBe('enc:hf_abc');
    expect(t.proc.posted).toContainEqual({ type: 'hf-token', token: 'hf_abc' });
    expect(await t.invoke('gpubench:hf-token-save', 5)).toEqual({ ok: false, secure: false });
    expect(await t.invoke('gpubench:hf-token-save', 'x'.repeat(513))).toEqual({ ok: false, secure: false });
    await t.invoke('gpubench:hf-token-clear');
    expect(t.files.has(path.join('/user', 'hf-token.bin'))).toBe(false);
    expect(t.proc.posted).toContainEqual({ type: 'hf-token', token: null });
    const plain = await started({ secure: false });
    expect(await plain.invoke('gpubench:hf-token-save', 'hf_x')).toEqual({ ok: true, secure: false });
  });

  it('IPC: exports saved through the native dialog, inputs validated', async () => {
    const t = await started();
    expect(await t.invoke('gpubench:save-file', { defaultName: '../../r.csv', content: 'a;b', filters: [{ name: 'CSV', extensions: ['csv'] }] })).toBe('/saved.csv');
    expect(t.files.get('/saved.csv')).toBe('a;b');
    expect(await t.invoke('gpubench:save-file', { defaultName: 'r.json', content: '{}' })).toBe('/saved.csv');
    expect(await t.invoke('gpubench:save-file', undefined)).toBeNull();
    expect(await t.invoke('gpubench:save-file', { defaultName: 1, content: 'x' })).toBeNull();
    expect(await t.invoke('gpubench:save-file', { defaultName: 'x', content: 2 })).toBeNull();
    expect(await t.invoke('gpubench:save-file', { defaultName: 'x', content: 'y'.repeat(MAX_SAVE_BYTES + 1) })).toBeNull();
    t.dialogs.save = { canceled: true };
    expect(await t.invoke('gpubench:save-file', { defaultName: 'x', content: 'y' })).toBeNull();
    t.dialogs.save = { canceled: false };
    expect(await t.invoke('gpubench:save-file', { defaultName: 'x', content: 'y' })).toBeNull();
  });

  it('a second launch focuses (and restores) the existing window', async () => {
    const t = await started();
    t.appEvents.get('second-instance')!();
    t.win.minimized = true;
    t.appEvents.get('second-instance')!();
    expect(t.win.focused).toBe(2);
    expect(t.win.restored).toBe(1);
    const early = world();
    startShell(early.e, early.h);
    expect(() => early.appEvents.get('second-instance')!()).not.toThrow();
  });

  it('the core failing at start-up explains it and exits', async () => {
    const w = world();
    startShell(w.e, w.h);
    w.readyResolve();
    await tick();
    w.proc.emit('exit', 3);
    await vi.waitFor(() => expect(w.calls.exit).toEqual([1]));
    expect(w.errors[0]).toContain('core exited with code 3');
  });

  it('a core crash later shows a message and relaunches the app', async () => {
    const t = await started();
    t.proc.emit('exit', 9);
    expect(t.errors[0]).toContain('codice 9');
    expect(t.calls.relaunch).toBe(1);
    expect(t.calls.exit).toEqual([1]);
    expect(t.s.core).toBeUndefined();
  });

  it('quitting asks the core to shut down, then quits (forcing it after a timeout)', async () => {
    const t = await started({ env: { NODE_V8_COVERAGE: '/cov' } });
    let prevented = 0;
    const beforeQuit = t.appEvents.get('before-quit')!;
    beforeQuit({ preventDefault: () => prevented++ });
    expect(t.proc.posted).toContainEqual({ type: 'shutdown' });
    t.proc.emit('exit', 0);
    await vi.waitFor(() => expect(t.calls.quit).toBe(1));
    expect(t.coverage()).toBe(1);
    // The second before-quit (from app.quit) goes through.
    beforeQuit({ preventDefault: () => prevented++ });
    expect(prevented).toBe(1);

    const slow = await started({ timeoutMs: 5 });
    slow.appEvents.get('before-quit')!({ preventDefault: () => {} });
    await vi.waitFor(() => expect(slow.proc.killed).toBe(true));
    await vi.waitFor(() => expect(slow.calls.quit).toBe(1));
    expect(slow.coverage()).toBe(0);

    const noCore = world();
    startShell(noCore.e, noCore.h);
    noCore.appEvents.get('before-quit')!({ preventDefault: () => {} });
    await vi.waitFor(() => expect(noCore.calls.quit).toBe(1));
  });

  it('closing the last window quits', async () => {
    const t = await started();
    t.appEvents.get('window-all-closed')!();
    expect(t.calls.quit).toBe(1);
  });

  it('a core exit during quit is expected', async () => {
    const t = await started();
    t.appEvents.get('before-quit')!({ preventDefault: () => {} });
    t.proc.emit('exit', 0);
    expect(t.errors).toEqual([]);
    expect(t.calls.relaunch).toBe(0);
  });

  it('uses the default shutdown grace period', async () => {
    const w = world();
    delete w.h.shutdownTimeoutMs;
    vi.useFakeTimers();
    try {
      startShell(w.e, w.h);
      w.readyResolve();
      await vi.advanceTimersByTimeAsync(0);
      w.proc.emit('message', { type: 'ready', port: 1 });
      await vi.advanceTimersByTimeAsync(0);
      w.appEvents.get('before-quit')!({ preventDefault: () => {} });
      await vi.advanceTimersByTimeAsync(3999);
      expect(w.proc.killed).toBe(false);
      await vi.advanceTimersByTimeAsync(2);
      expect(w.proc.killed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
