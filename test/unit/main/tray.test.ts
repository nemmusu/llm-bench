import { describe, expect, it } from 'vitest';
import type { ShellState } from '../../../src/contract/servers';
import { closeAction, shouldExplainHide, startupWindow } from '../../../src/main/close-behavior';
import { findCommand, menuLines, TOOLTIP_MAX, trayMenu, trayStatus, trayTooltip } from '../../../src/main/tray-menu';
import { runCommand, statusNotifierHost, trayAvailable, type CommandResult } from '../../../src/main/tray-support';
import { TRAY_TEXT, trayText } from '../../../src/main/tray-text';

function state(o: Partial<ShellState> = {}): ShellState {
  return { servers: [], presets: [], closeBehavior: 'tray-if-servers', launchAtLogin: false, language: 'it', ...o };
}

const two = state({
  servers: [
    { id: 's1', modelName: 'Qwen3 8B', port: 8080, url: 'http://127.0.0.1:8080/v1', status: 'ready', network: 'local', presetName: 'Chat veloce' },
    { id: 's2', modelName: 'Gemma 4 12B', port: 8081, url: 'http://192.168.1.20:8081/v1', status: 'ready', network: 'lan' },
  ],
  presets: [
    { id: 'p1', name: 'Chat veloce', port: 8080, running: true },
    { id: 'p2', name: 'Codice', port: 8090, running: false },
    { id: 'p3', name: 'Senza porta', running: false },
  ],
});

describe('tray menu', () => {
  it('two servers and three presets, in Italian (snapshot)', () => {
    expect(menuLines(trayMenu(two, 'it'))).toMatchInlineSnapshot(`
      [
        "Apri GPU Bench",
        "---",
        "Chat veloce · porta 8080",
        "Copia indirizzo",
        "Ferma (chiudi modello)",
        "Riavvia",
        "---",
        "Gemma 4 12B · porta 8081 · rete locale",
        "Copia indirizzo",
        "Ferma (chiudi modello)",
        "Riavvia",
        "---",
        "Avvia preset ▸",
        "  Chat veloce · già acceso (x)",
        "  Codice · porta 8090",
        "  Senza porta",
        "Ferma tutti i server",
        "---",
        "Esci",
      ]
    `);
  });

  it('nothing running yet (or no state from the core yet), in English (snapshot)', () => {
    expect(menuLines(trayMenu(undefined, 'en'))).toMatchInlineSnapshot(`
      [
        "Open GPU Bench",
        "---",
        "Start preset ▸",
        "  No saved presets (x)",
        "Stop all servers (x)",
        "---",
        "Quit",
      ]
    `);
  });

  it('a server still starting cannot be restarted yet', () => {
    const loading = state({ servers: [{ id: 's1', modelName: 'Qwen3 8B', port: 8080, url: 'u', status: 'loading', network: 'local' }] });
    expect(menuLines(trayMenu(loading, 'it'))).toEqual(expect.arrayContaining(['Qwen3 8B · porta 8080 · si avvia…', 'Riavvia (x)', 'Ferma (chiudi modello)']));
  });

  it('every item leads to its command, addressed by section', () => {
    const items = trayMenu(two, 'it');
    expect(findCommand(items, ['Apri GPU Bench'])).toEqual({ kind: 'open' });
    expect(findCommand(items, ['Chat veloce · porta 8080', 'Copia indirizzo'])).toEqual({ kind: 'copy', url: 'http://127.0.0.1:8080/v1' });
    expect(findCommand(items, ['Gemma 4 12B · porta 8081 · rete locale', 'Copia indirizzo'])).toEqual({ kind: 'copy', url: 'http://192.168.1.20:8081/v1' });
    expect(findCommand(items, ['Gemma 4 12B · porta 8081 · rete locale', 'Ferma (chiudi modello)'])).toEqual({ kind: 'stop', id: 's2' });
    expect(findCommand(items, ['Chat veloce · porta 8080', 'Riavvia'])).toEqual({ kind: 'restart', id: 's1' });
    expect(findCommand(items, ['Avvia preset', 'Codice · porta 8090'])).toEqual({ kind: 'start-preset', id: 'p2' });
    expect(findCommand(items, ['Ferma tutti i server'])).toEqual({ kind: 'stop-all' });
    expect(findCommand(items, ['Esci'])).toEqual({ kind: 'quit' });
    // A heading alone, a disabled item, an unknown label: nothing to do.
    expect(findCommand(items, ['Chat veloce · porta 8080'])).toBeUndefined();
    expect(findCommand(items, ['Avvia preset', 'Chat veloce · già acceso'])).toBeUndefined();
    expect(findCommand(items, ['Nope'])).toBeUndefined();
    expect(findCommand(items, ['Esci', 'more'])).toBeUndefined();
    expect(findCommand(trayMenu(undefined, 'it'), ['Ferma tutti i server'])).toBeUndefined();
  });

  it('icon: idle, running, loading', () => {
    expect(trayStatus(undefined)).toBe('idle');
    expect(trayStatus(state())).toBe('idle');
    expect(trayStatus(two)).toBe('running');
    expect(trayStatus(state({ servers: [...two.servers, { ...two.servers[0]!, id: 's3', status: 'loading' }] }))).toBe('loading');
  });

  it('tooltip: the servers with their ports, cut at the Windows limit', () => {
    expect(trayTooltip(undefined, 'it')).toBe('GPU Bench');
    expect(trayTooltip(state({ servers: [two.servers[0]!] }), 'it')).toBe('GPU Bench · 1 server attivo: Qwen3 8B (8080)');
    expect(trayTooltip(two, 'en')).toBe('GPU Bench · 2 servers running: Qwen3 8B (8080), Gemma 4 12B (8081)');
    expect(trayTooltip(state({ servers: [{ ...two.servers[0]!, status: 'loading' }] }), 'it')).toBe('GPU Bench · 1 server attivo: Qwen3 8B si avvia');
    const many = state({ servers: Array.from({ length: 9 }, (_, i) => ({ ...two.servers[0]!, id: `s${i}`, modelName: `Modello lunghissimo ${i}`, port: 8080 + i })) });
    const tip = trayTooltip(many, 'it');
    expect(tip).toHaveLength(TOOLTIP_MAX);
    expect(tip.endsWith('…')).toBe(true);
  });

  it('texts: the same keys in both languages; unknown placeholders stay', () => {
    expect(Object.keys(TRAY_TEXT.en).sort()).toEqual(Object.keys(TRAY_TEXT.it).sort());
    expect(trayText('it', 'server', { model: 'X' })).toBe('X · porta {port}');
  });
});

describe('closing the window', () => {
  it('default: hides to the tray only while a server runs', () => {
    expect(closeAction({ quitting: false, behavior: 'tray-if-servers', servers: 0, tray: true })).toBe('quit');
    expect(closeAction({ quitting: false, behavior: 'tray-if-servers', servers: 1, tray: true })).toBe('hide');
  });
  it('"Sempre" hides even with nothing running; "Esci sempre" quits even with servers', () => {
    expect(closeAction({ quitting: false, behavior: 'tray', servers: 0, tray: true })).toBe('hide');
    expect(closeAction({ quitting: false, behavior: 'quit', servers: 3, tray: true })).toBe('quit');
  });
  it('no tray on this desktop: minimized instead; quitting always lets the window go', () => {
    expect(closeAction({ quitting: false, behavior: 'tray', servers: 1, tray: false })).toBe('minimize');
    expect(closeAction({ quitting: true, behavior: 'tray', servers: 1, tray: true })).toBe('quit');
  });
  it('the one-time explanation, and the window at a login start', () => {
    expect(shouldExplainHide('hide', false)).toBe(true);
    expect(shouldExplainHide('hide', true)).toBe(false);
    expect(shouldExplainHide('minimize', false)).toBe(false);
    expect(startupWindow({ hiddenStart: false, tray: true })).toBe('show');
    expect(startupWindow({ hiddenStart: true, tray: true })).toBe('hide');
    expect(startupWindow({ hiddenStart: true, tray: false })).toBe('minimize');
  });
});

describe('tray support', () => {
  const answers = (gdbus: CommandResult, send: CommandResult = { code: null, stdout: '' }) => {
    const calls: string[] = [];
    return {
      calls,
      run: async (cmd: string) => {
        calls.push(cmd);
        return cmd === 'gdbus' ? gdbus : send;
      },
    };
  };

  it('asks the session bus whether a StatusNotifier panel is there (gdbus, else dbus-send)', async () => {
    expect(await statusNotifierHost(answers({ code: 0, stdout: '(true,)\n' }).run)).toBe(true);
    expect(await statusNotifierHost(answers({ code: 0, stdout: '(false,)\n' }).run)).toBe(false);
    const viaSend = answers({ code: null, stdout: '' }, { code: 0, stdout: 'method return\n   boolean true\n' });
    expect(await statusNotifierHost(viaSend.run)).toBe(true);
    expect(viaSend.calls).toEqual(['gdbus', 'dbus-send']);
    expect(await statusNotifierHost(answers({ code: 1, stdout: '' }, { code: 0, stdout: 'boolean false' }).run)).toBe(false);
    expect(await statusNotifierHost(answers({ code: 1, stdout: '' }, { code: 1, stdout: '' }).run)).toBeUndefined();
  });

  it('Windows always; Linux by panel, desktop and session; never with GPUBENCH_NO_TRAY', async () => {
    const none = answers({ code: 1, stdout: '' });
    expect(await trayAvailable({ platform: 'win32', env: {}, run: none.run })).toBe(true);
    expect(none.calls).toEqual([]);
    expect(await trayAvailable({ platform: 'win32', env: { GPUBENCH_NO_TRAY: '1' }, run: none.run })).toBe(false);
    const sni = answers({ code: 0, stdout: '(true,)' });
    expect(await trayAvailable({ platform: 'linux', env: { XDG_CURRENT_DESKTOP: 'GNOME' }, run: sni.run })).toBe(true);
    const noSni = answers({ code: 0, stdout: '(false,)' });
    // GNOME without the AppIndicator extension: nothing shows the icon.
    expect(await trayAvailable({ platform: 'linux', env: { XDG_CURRENT_DESKTOP: 'ubuntu:GNOME' }, run: noSni.run })).toBe(false);
    // XFCE on X11 still has the old tray; on Wayland it does not.
    expect(await trayAvailable({ platform: 'linux', env: { XDG_CURRENT_DESKTOP: 'XFCE', XDG_SESSION_TYPE: 'x11' }, run: noSni.run })).toBe(true);
    expect(await trayAvailable({ platform: 'linux', env: { XDG_CURRENT_DESKTOP: 'XFCE', XDG_SESSION_TYPE: 'wayland' }, run: noSni.run })).toBe(false);
    // The bus cannot be asked: only GNOME is known to have none.
    expect(await trayAvailable({ platform: 'linux', env: { XDG_CURRENT_DESKTOP: 'GNOME' }, run: none.run })).toBe(false);
    expect(await trayAvailable({ platform: 'linux', env: {}, run: none.run })).toBe(true);
  });

  it('runs a program and never throws', async () => {
    expect(await runCommand(process.execPath, ['-e', 'process.stdout.write("hi")'])).toEqual({ code: 0, stdout: 'hi' });
    expect((await runCommand(process.execPath, ['-e', 'process.exit(3)'])).code).toBe(3);
    expect(await runCommand('gpubench-no-such-program-xyz', [])).toEqual({ code: null, stdout: '' });
  });
});
