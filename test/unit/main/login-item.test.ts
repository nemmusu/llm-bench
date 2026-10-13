import { describe, expect, it } from 'vitest';
import {
  autostartEntry,
  autostartFile,
  execArg,
  launchArgv,
  loginItemEnabled,
  migrateLegacyLoginItem,
  regValues,
  RUN_KEY,
  setLoginItem,
  STARTUP_APPROVED_KEY,
  type LoginItemHost,
  type LoginItemSettings,
} from '../../../src/main/login-item';

/** Never the real login items: a registry and a file system in memory. */
function host(o: Partial<LoginItemHost> & { reg?: Record<string, string> } = {}) {
  const files = new Map<string, string>();
  const set: LoginItemSettings[] = [];
  const asked: { path: string; args: string[]; name: string }[] = [];
  const ran: string[][] = [];
  let enabled = false;
  const h: LoginItemHost = {
    platform: 'win32',
    env: {},
    home: '/home/anna',
    execPath: 'C:\\Program Files\\LLM Bench\\LLM Bench.exe',
    fs: {
      readFile: async (p) => {
        const v = files.get(p);
        if (v === undefined) throw new Error('ENOENT');
        return Buffer.from(v);
      },
      writeFile: async (p, d) => void files.set(p, String(d)),
      mkdir: async () => undefined,
      rm: async (p) => void files.delete(p),
    },
    getLoginItemSettings: (q) => {
      asked.push(q);
      return { openAtLogin: enabled };
    },
    setLoginItemSettings: (s) => {
      set.push(s);
      enabled = s.openAtLogin;
    },
    // `reg query <key>`: what the registry holds under that key, else nothing (reg.exe missing).
    run: async (cmd, args) => {
      ran.push([cmd, ...args]);
      const out = o.reg?.[args[1] as string];
      return out === undefined ? { code: null, stdout: '' } : { code: 0, stdout: out };
    },
    ...o,
  };
  return { h, files, set, asked, ran };
}

const OLD_EXE = 'C:\\Users\\anna\\AppData\\Local\\Programs\\gpu-bench\\GPU Bench.exe';

/** `reg query` output of the Run key: OneDrive, GPU Bench's login item, and maybe more. */
function runKey(...extra: string[]): string {
  return [
    '',
    `${RUN_KEY.replace('HKCU', 'HKEY_CURRENT_USER')}`,
    '    OneDrive    REG_SZ    "C:\\Program Files\\Microsoft OneDrive\\OneDrive.exe" /background',
    `    electron.app.GPU Bench    REG_SZ    "${OLD_EXE}" --hidden`,
    ...extra,
    '',
  ].join('\r\n');
}

describe('start at login', () => {
  it('Windows: the login item starts the app hidden in the tray (the portable exe itself when portable)', async () => {
    const { h, set, asked } = host();
    expect(await loginItemEnabled(h)).toBe(false);
    // The registry value is named after the app (not Electron's default app id).
    expect(asked).toEqual([{ path: 'C:\\Program Files\\LLM Bench\\LLM Bench.exe', args: ['--hidden'], name: 'LLM Bench' }]);
    await setLoginItem(h, true);
    expect(set).toEqual([{ openAtLogin: true, path: 'C:\\Program Files\\LLM Bench\\LLM Bench.exe', args: ['--hidden'], name: 'LLM Bench' }]);
    expect(await loginItemEnabled(h)).toBe(true);
    await setLoginItem(h, false);
    expect(set.at(-1)).toMatchObject({ openAtLogin: false, name: 'LLM Bench' });
    const portable = host({ env: { PORTABLE_EXECUTABLE_FILE: 'D:\\LLM-Bench-portable.exe' } });
    await setLoginItem(portable.h, true);
    expect(portable.set[0]).toMatchObject({ path: 'D:\\LLM-Bench-portable.exe', args: ['--hidden'] });
    // Unpackaged (development): Electron needs the app folder first.
    expect(launchArgv({ env: {}, execPath: 'electron.exe', appPath: 'C:\\src\\llm-bench' })).toEqual(['electron.exe', 'C:\\src\\llm-bench', '--hidden']);
  });

  it('Linux: an XDG autostart entry, removed when turned off (the AppImage itself when run from one)', async () => {
    const { h, files } = host({ platform: 'linux', execPath: '/opt/LLM Bench/llm-bench' });
    const file = '/home/anna/.config/autostart/llm-bench.desktop';
    expect(autostartFile({}, '/home/anna')).toBe(file);
    expect(autostartFile({ XDG_CONFIG_HOME: '/cfg' }, '/home/anna')).toBe('/cfg/autostart/llm-bench.desktop');
    expect(await loginItemEnabled(h)).toBe(false);
    await setLoginItem(h, true);
    expect(files.get(file)).toContain('Exec="/opt/LLM Bench/llm-bench" --hidden\nX-GNOME-Autostart-enabled=true\n');
    expect(files.get(file)).toMatch(/^\[Desktop Entry\]\nType=Application\nName=LLM Bench\n/);
    expect(await loginItemEnabled(h)).toBe(true);
    await setLoginItem(h, false);
    expect(files.has(file)).toBe(false);
    expect(launchArgv({ env: { APPIMAGE: '/home/anna/Apps/llm-bench.AppImage' }, execPath: '/tmp/.mount_x/llm-bench' })).toEqual(['/home/anna/Apps/llm-bench.AppImage', '--hidden']);
  });

  it('Exec quoting follows the Desktop Entry spec', () => {
    expect(execArg('/usr/bin/llm-bench')).toBe('/usr/bin/llm-bench');
    expect(execArg('')).toBe('""');
    expect(execArg('/a b/c$d"e`f\\g')).toBe('"/a b/c\\$d\\"e\\`f\\\\g"');
    // String values escape the backslash once more.
    expect(autostartEntry(['/x\\y'])).toContain('Exec="/x\\\\\\\\y"');
    expect(autostartEntry(['/x'], false)).toContain('X-GNOME-Autostart-enabled=false\n');
  });

  it('tests use a file instead of the real login items (GPUBENCH_FAKE_LOGIN_ITEM)', async () => {
    const { h, files, set } = host({ env: { GPUBENCH_FAKE_LOGIN_ITEM: '/tmp/login.json' } });
    expect(await loginItemEnabled(h)).toBe(false);
    await setLoginItem(h, true);
    expect(JSON.parse(files.get('/tmp/login.json')!)).toEqual({ openAtLogin: true, argv: ['C:\\Program Files\\LLM Bench\\LLM Bench.exe', '--hidden'] });
    expect(await loginItemEnabled(h)).toBe(true);
    expect(set).toEqual([]);
  });
});

describe('GPU Bench’s start at login becomes LLM Bench’s (the rename, once)', () => {
  it('reads `reg query` values, names with spaces included', () => {
    expect(regValues(runKey('    Path    REG_EXPAND_SZ    %USERPROFILE%\\x.exe  ', 'not a value line'))).toEqual([
      { name: 'OneDrive', data: '"C:\\Program Files\\Microsoft OneDrive\\OneDrive.exe" /background' },
      { name: 'electron.app.GPU Bench', data: `"${OLD_EXE}" --hidden` },
      { name: 'Path', data: '%USERPROFILE%\\x.exe' },
    ]);
  });

  it('Windows: the old value is removed (found by its command, whatever its name), the new one made', async () => {
    const portable = '    GPU Bench portable    REG_SZ    "D:\\Apps\\GPU-Bench-0.3.0-portable.exe" --hidden';
    const { h, set, ran } = host({ reg: { [RUN_KEY]: runKey(portable), [STARTUP_APPROVED_KEY]: '    electron.app.GPU Bench    REG_BINARY    020000000000000000000000\r\n' } });
    expect(await migrateLegacyLoginItem(h)).toBe(true);
    expect(ran).toEqual([
      ['reg', 'query', RUN_KEY],
      ['reg', 'query', STARTUP_APPROVED_KEY],
    ]);
    expect(set).toEqual([
      { openAtLogin: false, name: 'electron.app.GPU Bench' },
      { openAtLogin: false, name: 'GPU Bench portable' },
      { openAtLogin: true, path: 'C:\\Program Files\\LLM Bench\\LLM Bench.exe', args: ['--hidden'], name: 'LLM Bench', enabled: true },
    ]);
  });

  it('Windows: turned off by the user in Task Manager stays off (StartupApproved 03…)', async () => {
    const { h, set } = host({ reg: { [RUN_KEY]: runKey(), [STARTUP_APPROVED_KEY]: '    electron.app.GPU Bench    REG_BINARY    0300000062F1E8B6\r\n' } });
    expect(await migrateLegacyLoginItem(h)).toBe(true);
    expect(set.at(-1)).toMatchObject({ openAtLogin: true, name: 'LLM Bench', enabled: false });
    // No StartupApproved value at all: enabled, as Windows treats it.
    const none = host({ reg: { [RUN_KEY]: runKey() } });
    expect(await migrateLegacyLoginItem(none.h)).toBe(true);
    expect(none.set.at(-1)).toMatchObject({ openAtLogin: true, enabled: true });
  });

  it('Windows: no login item of GPU Bench (or no reg.exe): nothing is touched', async () => {
    const other = host({ reg: { [RUN_KEY]: '    OneDrive    REG_SZ    "C:\\OneDrive.exe" /background\r\n    GPU Bench    REG_SZ    "C:\\GPU Bench.exe"\r\n' } });
    expect(await migrateLegacyLoginItem(other.h)).toBe(false);
    expect(other.set).toEqual([]);
    expect(other.ran).toEqual([['reg', 'query', RUN_KEY]]);
    const noReg = host();
    expect(await migrateLegacyLoginItem(noReg.h)).toBe(false);
  });

  it('Linux: gpu-bench.desktop becomes llm-bench.desktop, enabled or not as it was', async () => {
    const on = host({ platform: 'linux', execPath: '/opt/LLM Bench/llm-bench' });
    on.files.set('/home/anna/.config/autostart/gpu-bench.desktop', '[Desktop Entry]\nName=GPU Bench\nExec="/opt/GPU Bench/gpu-bench" --hidden\nX-GNOME-Autostart-enabled=true\n');
    expect(await migrateLegacyLoginItem(on.h)).toBe(true);
    expect(on.files.has('/home/anna/.config/autostart/gpu-bench.desktop')).toBe(false);
    expect(on.files.get('/home/anna/.config/autostart/llm-bench.desktop')).toContain('Name=LLM Bench\nExec="/opt/LLM Bench/llm-bench" --hidden\nX-GNOME-Autostart-enabled=true\n');
    const off = host({ platform: 'linux', env: { XDG_CONFIG_HOME: '/cfg' } });
    off.files.set('/cfg/autostart/gpu-bench.desktop', '[Desktop Entry]\nX-GNOME-Autostart-enabled=false\n');
    expect(await migrateLegacyLoginItem(off.h)).toBe(true);
    expect(off.files.get('/cfg/autostart/llm-bench.desktop')).toContain('X-GNOME-Autostart-enabled=false\n');
    // None there: nothing made.
    const none = host({ platform: 'linux' });
    expect(await migrateLegacyLoginItem(none.h)).toBe(false);
    expect(none.files.size).toBe(0);
  });

  it('never in tests (GPUBENCH_FAKE_LOGIN_ITEM), nor on other systems', async () => {
    const fake = host({ env: { GPUBENCH_FAKE_LOGIN_ITEM: '/tmp/login.json' }, reg: { [RUN_KEY]: runKey() } });
    expect(await migrateLegacyLoginItem(fake.h)).toBe(false);
    expect(fake.ran).toEqual([]);
    const mac = host({ platform: 'darwin', reg: { [RUN_KEY]: runKey() } });
    expect(await migrateLegacyLoginItem(mac.h)).toBe(false);
    expect(mac.ran).toEqual([]);
  });
});
