import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ShellDocker, ShellState } from '../../../src/contract/servers';
import { findCommand, menuLines, trayMenu, trayTooltip } from '../../../src/main/tray-menu';
import { coreState, oneServer, started } from './harness';

const withDocker = (docker: ShellDocker, base: ShellState = coreState()): ShellState => ({ ...base, docker });

describe('Docker in the tray menu', () => {
  it('not responding: its state and "Riavvia Docker" (snapshot)', () => {
    expect(menuLines(trayMenu(withDocker({ state: 'not-responding', control: true }, oneServer), 'it'))).toMatchInlineSnapshot(`
      [
        "Apri LLM Bench",
        "---",
        "Qwen3 8B · porta 8080",
        "Copia indirizzo",
        "Ferma (chiudi modello)",
        "Riavvia",
        "---",
        "Avvia preset ▸",
        "  Codice · porta 8090",
        "Ferma tutti i server",
        "---",
        "Docker: non risponde",
        "Riavvia Docker",
        "---",
        "Esci",
      ]
    `);
  });

  it('off: "Avvia Docker"; running: "Riavvia Docker" too; while it changes: only what it is doing (snapshot, English)', () => {
    const lines = (d: ShellDocker) => menuLines(trayMenu(withDocker(d), 'en')).slice(5, -2);
    expect(lines({ state: 'stopped', control: true })).toEqual(['---', 'Docker: not running', 'Start Docker']);
    expect(lines({ state: 'running', control: true })).toEqual(['---', 'Docker: running', 'Restart Docker']);
    expect(lines({ state: 'starting', control: true })).toEqual(['---', 'Docker: starting…']);
    expect(lines({ state: 'stopped', busy: 'starting', control: true })).toEqual(['---', 'Docker: starting…']);
    expect(lines({ state: 'not-responding', busy: 'restarting', control: true })).toEqual(['---', 'Docker: restarting…']);
  });

  it('nothing about Docker where it is not installed, broken in other ways, or a system service that answers', () => {
    const plain = menuLines(trayMenu(coreState(), 'it'));
    for (const d of [
      { state: 'not-installed', control: true },
      { state: 'no-gpu', control: true },
      { state: 'unknown', control: true },
      { state: 'running', control: false },
      { state: 'stopped', control: false },
    ] as ShellDocker[]) {
      expect(menuLines(trayMenu(withDocker(d), 'it'))).toEqual(plain);
    }
    // Linux, stuck: said, with no button (the command is in the window).
    expect(menuLines(trayMenu(withDocker({ state: 'not-responding', control: false }), 'it'))).toContain('Docker: non risponde');
    expect(menuLines(trayMenu(withDocker({ state: 'not-responding', control: false }), 'it'))).not.toContain('Riavvia Docker');
  });

  it('its items lead to their commands', () => {
    const stuck = trayMenu(withDocker({ state: 'not-responding', control: true }), 'it');
    expect(findCommand(stuck, ['Riavvia Docker'])).toEqual({ kind: 'docker-restart' });
    expect(findCommand(stuck, ['Docker: non risponde', 'Riavvia Docker'])).toEqual({ kind: 'docker-restart' });
    expect(findCommand(trayMenu(withDocker({ state: 'stopped', control: true }), 'it'), ['Avvia Docker'])).toEqual({ kind: 'docker-start' });
  });

  it('the tooltip says Docker does not answer', () => {
    expect(trayTooltip(withDocker({ state: 'not-responding', control: true }), 'it')).toBe('LLM Bench · Docker non risponde');
    expect(trayTooltip(withDocker({ state: 'not-responding', control: true }, oneServer), 'en')).toBe('LLM Bench · 1 server running: Qwen3 8B (8080) · Docker is not responding');
    expect(trayTooltip(withDocker({ state: 'running', control: true }), 'it')).toBe('LLM Bench');
  });
});

describe('Docker from the tray (main process)', () => {
  it('"Avvia Docker" and "Riavvia Docker" go to the core; a stuck Docker is a notification', async () => {
    const t = await started();
    t.proc.emit('message', { type: 'shell-state', state: withDocker({ state: 'stopped', control: true }) });
    t.proc.posted.length = 0;
    t.tray!.click('Avvia Docker');
    t.proc.emit('message', { type: 'shell-state', state: withDocker({ state: 'not-responding', control: true }) });
    t.tray!.click('Riavvia Docker');
    expect(t.proc.posted).toEqual([
      { type: 'tray', action: 'docker-start' },
      { type: 'tray', action: 'docker-restart' },
    ]);
    t.proc.emit('message', { type: 'shell-notice', notice: { kind: 'docker-stuck' } });
    expect(t.shown).toEqual([
      {
        title: 'Docker non risponde',
        body: 'I server in Docker non funzionano più. Scegli «Riavvia Docker» dal menu di LLM Bench vicino all’orologio, oppure apri LLM Bench.',
        icon: path.resolve('/app/out/main', '../../resources/icons/icon.png'),
      },
    ]);
  });
});
