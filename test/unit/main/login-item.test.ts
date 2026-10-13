import { describe, expect, it } from 'vitest';
import { autostartEntry, autostartFile, execArg, launchArgv, loginItemEnabled, setLoginItem, type LoginItemHost, type LoginItemSettings } from '../../../src/main/login-item';

/** Never the real login items: a registry and a file system in memory. */
function host(o: Partial<LoginItemHost> = {}) {
  const files = new Map<string, string>();
  const set: LoginItemSettings[] = [];
  let enabled = false;
  const h: LoginItemHost = {
    platform: 'win32',
    env: {},
    home: '/home/anna',
    execPath: 'C:\\Program Files\\GPU Bench\\GPU Bench.exe',
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
    getLoginItemSettings: () => ({ openAtLogin: enabled }),
    setLoginItemSettings: (s) => {
      set.push(s);
      enabled = s.openAtLogin;
    },
    ...o,
  };
  return { h, files, set };
}

describe('start at login', () => {
  it('Windows: the login item starts the app hidden in the tray (the portable exe itself when portable)', async () => {
    const { h, set } = host();
    expect(await loginItemEnabled(h)).toBe(false);
    await setLoginItem(h, true);
    expect(set).toEqual([{ openAtLogin: true, path: 'C:\\Program Files\\GPU Bench\\GPU Bench.exe', args: ['--hidden'] }]);
    expect(await loginItemEnabled(h)).toBe(true);
    await setLoginItem(h, false);
    expect(set.at(-1)?.openAtLogin).toBe(false);
    const portable = host({ env: { PORTABLE_EXECUTABLE_FILE: 'D:\\GPU-Bench-portable.exe' } });
    await setLoginItem(portable.h, true);
    expect(portable.set[0]).toMatchObject({ path: 'D:\\GPU-Bench-portable.exe', args: ['--hidden'] });
    // Unpackaged (development): Electron needs the app folder first.
    expect(launchArgv({ env: {}, execPath: 'electron.exe', appPath: 'C:\\src\\gpu-bench' })).toEqual(['electron.exe', 'C:\\src\\gpu-bench', '--hidden']);
  });

  it('Linux: an XDG autostart entry, removed when turned off (the AppImage itself when run from one)', async () => {
    const { h, files } = host({ platform: 'linux', execPath: '/opt/GPU Bench/gpu-bench' });
    const file = '/home/anna/.config/autostart/gpu-bench.desktop';
    expect(autostartFile({}, '/home/anna')).toBe(file);
    expect(autostartFile({ XDG_CONFIG_HOME: '/cfg' }, '/home/anna')).toBe('/cfg/autostart/gpu-bench.desktop');
    expect(await loginItemEnabled(h)).toBe(false);
    await setLoginItem(h, true);
    expect(files.get(file)).toContain('Exec="/opt/GPU Bench/gpu-bench" --hidden\n');
    expect(files.get(file)).toMatch(/^\[Desktop Entry\]\nType=Application\nName=GPU Bench\n/);
    expect(await loginItemEnabled(h)).toBe(true);
    await setLoginItem(h, false);
    expect(files.has(file)).toBe(false);
    expect(launchArgv({ env: { APPIMAGE: '/home/anna/Apps/gpu-bench.AppImage' }, execPath: '/tmp/.mount_x/gpu-bench' })).toEqual(['/home/anna/Apps/gpu-bench.AppImage', '--hidden']);
  });

  it('Exec quoting follows the Desktop Entry spec', () => {
    expect(execArg('/usr/bin/gpu-bench')).toBe('/usr/bin/gpu-bench');
    expect(execArg('')).toBe('""');
    expect(execArg('/a b/c$d"e`f\\g')).toBe('"/a b/c\\$d\\"e\\`f\\\\g"');
    // String values escape the backslash once more.
    expect(autostartEntry(['/x\\y'])).toContain('Exec="/x\\\\\\\\y"');
  });

  it('tests use a file instead of the real login items (GPUBENCH_FAKE_LOGIN_ITEM)', async () => {
    const { h, files, set } = host({ env: { GPUBENCH_FAKE_LOGIN_ITEM: '/tmp/login.json' } });
    expect(await loginItemEnabled(h)).toBe(false);
    await setLoginItem(h, true);
    expect(JSON.parse(files.get('/tmp/login.json')!)).toEqual({ openAtLogin: true, argv: ['C:\\Program Files\\GPU Bench\\GPU Bench.exe', '--hidden'] });
    expect(await loginItemEnabled(h)).toBe(true);
    expect(set).toEqual([]);
  });
});
