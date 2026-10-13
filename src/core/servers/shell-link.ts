/**
 * The core's side of the tray: it tells the Electron main process what runs (servers, presets, the
 * close behaviour, the language) whenever that changes, and carries out the tray's commands
 * ("Ferma (chiudi modello)", "Riavvia", "Avvia preset", "Ferma tutti i server"), the start-up of the
 * "Avvia all'apertura" presets and the saving of the API key; and Docker: its state in the menu,
 * "Avvia Docker" / "Riavvia Docker", a notification when it stops answering. Messages: contract/servers.ts.
 */
import type { ServerInfo } from '../../contract/api';
import type { ServerEvent } from '../../contract/events';
import { shellToCoreSchema, type CoreToShell, type ServerPreset, type ShellDocker, type ShellState } from '../../contract/servers';
import type { Settings } from '../../contract/settings';
import type { Logger } from '../deps';
import type { ServerKeys } from './api-key';
import type { ServerNotices } from './notices';
import type { ServeService } from './service';

/** The utility process's parent port (bootstrap.ts ParentPort). */
export interface ShellChannel {
  postMessage(msg: unknown): void;
  on(ev: 'message', cb: (e: { data: unknown }) => void): void;
}

/** What the tray shows, from the servers, the presets, the settings and Docker. */
export function shellStateOf(
  servers: readonly ServerInfo[],
  presets: readonly ServerPreset[],
  settings: Pick<Settings, 'closeBehavior' | 'launchAtLogin' | 'language'>,
  docker?: ShellDocker,
): ShellState {
  const runningPresets = new Set(servers.map((s) => s.presetId).filter((id): id is string => id !== undefined));
  return {
    servers: servers.map((s) => ({
      id: s.id,
      modelName: s.modelLabel,
      port: s.port,
      url: s.network === 'lan' ? (s.lanUrls[0] ?? s.openaiUrl) : s.openaiUrl,
      status: s.loading ? 'loading' : 'ready',
      network: s.network,
      ...(s.presetName !== undefined ? { presetName: s.presetName } : {}),
    })),
    presets: presets.map((p) => ({ id: p.id, name: p.name, ...(p.port !== undefined ? { port: p.port } : {}), running: runningPresets.has(p.id) })),
    closeBehavior: settings.closeBehavior,
    launchAtLogin: settings.launchAtLogin,
    language: settings.language,
    ...(docker ? { docker } : {}),
  };
}

export interface ShellLinkDeps {
  channel: ShellChannel;
  serve: ServeService;
  presets: { list(): Promise<ServerPreset[]> };
  keys: ServerKeys;
  notices: ServerNotices;
  settings: { get(): Promise<Settings>; subscribe(fn: () => void): () => void };
  hub: { subscribe(fn: (e: ServerEvent) => void): () => void };
  shutdown: AbortSignal;
  log: Logger;
  /** DockerControl: its state for the menu, its commands, and when it gets stuck. */
  docker?: {
    shell(): ShellDocker | undefined;
    subscribe(fn: () => void): () => void;
    onStuck(fn: () => void): () => void;
    start(): boolean;
    restart(): boolean;
  };
}

export interface ShellLink {
  /** Sends the current state now (also called on every change). */
  push(): Promise<void>;
}

export function attachShell(d: ShellLinkDeps): ShellLink {
  const post = (m: CoreToShell) => d.channel.postMessage(m);
  let last = '';
  /** Notices already turned into a notification (each failure is announced once). */
  const announced = new Set<string>();

  const push = async (): Promise<void> => {
    const [presets, settings] = await Promise.all([d.presets.list(), d.settings.get()]);
    const state = shellStateOf(d.serve.list(), presets, settings, d.docker?.shell());
    const json = JSON.stringify(state);
    if (json !== last) {
      last = json;
      post({ type: 'shell-state', state });
    }
    for (const n of d.notices.list()) {
      if (announced.has(n.id)) continue;
      announced.add(n.id);
      post({ type: 'shell-notice', notice: { kind: 'start-failed', name: n.name } });
    }
  };

  // Many changes come at once (a server listed, then ready; a preset saved): one message for all of them.
  let queued = false;
  const schedule = () => {
    if (queued) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      void push().catch((e: unknown) => d.log.warn('tray state not sent', { error: String(e) }));
    });
  };
  d.hub.subscribe((e) => {
    if (e.type === 'servers.changed') schedule();
  });
  d.settings.subscribe(schedule);
  d.docker?.subscribe(schedule);
  // Nobody may be looking at the window while a server runs in Docker: the tray says it.
  d.docker?.onStuck(() => post({ type: 'shell-notice', notice: { kind: 'docker-stuck' } }));

  const failed = (what: string) => (e: unknown) => d.log.warn(`tray: ${what} failed`, { error: String(e) });
  d.channel.on('message', (e) => {
    const parsed = shellToCoreSchema.safeParse(e.data);
    if (!parsed.success) return;
    const msg = parsed.data;
    switch (msg.type) {
      case 'server-api-key':
        d.keys.restore(msg.key, msg.storage);
        break;
      case 'autostart':
        void d.serve.autoStart(d.shutdown).catch(failed('autostart'));
        break;
      case 'tray':
        if (msg.action === 'stop-all') void d.serve.stopAll();
        else if (msg.action === 'stop' && msg.id) void d.serve.stop(msg.id).catch(failed('stop'));
        else if (msg.action === 'restart' && msg.id) {
          const s = d.serve.list().find((x) => x.id === msg.id);
          if (!s) break;
          // Nobody is looking at the window: a restart that fails is said on the Server page and in a notification.
          void d.serve.restart(s.id, d.shutdown).catch((e: unknown) => {
            if (!d.shutdown.aborted) d.notices.add('tray-start-failed', { ...(s.presetId !== undefined ? { id: s.presetId } : {}), name: s.presetName ?? s.modelLabel }, e);
          });
        }
        else if (msg.action === 'start-preset' && msg.id) void d.serve.startUnattended(msg.id, 'tray-start-failed', d.shutdown);
        else if (msg.action === 'docker-start') d.docker?.start();
        else if (msg.action === 'docker-restart') d.docker?.restart();
        break;
      default:
        // 'shutdown' and 'hf-token' belong to bootstrap.ts.
        break;
    }
  });
  schedule();
  return { push };
}
