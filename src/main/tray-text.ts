/**
 * Words of the tray icon, its menu and the main process's notifications and dialogs, in both
 * languages (the renderer's i18n lives in another process). Keys are identical in it and en; {app}
 * is the product's name (app-name.ts).
 */
import { APP_NAME } from './app-name';

export const TRAY_TEXT = {
  it: {
    open: 'Apri {app}',
    server: '{model} · porta {port}',
    serverLoading: '{model} · porta {port} · si avvia…',
    serverLan: '{model} · porta {port} · rete locale',
    copy: 'Copia indirizzo',
    stop: 'Ferma (chiudi modello)',
    restart: 'Riavvia',
    startPreset: 'Avvia preset',
    noPresets: 'Nessun preset salvato',
    presetPort: '{name} · porta {port}',
    presetRunning: '{name} · già acceso',
    stopAll: 'Ferma tutti i server',
    quit: 'Esci',
    tooltipIdle: '{app}',
    tooltipOne: '{app} · 1 server attivo: {list}',
    tooltipMany: '{app} · {n} server attivi: {list}',
    tooltipLoading: '{model} si avvia',
    hiddenTitle: '{app} è ancora attivo',
    hiddenBody: '{app} resta attivo nell’area di notifica: il server continua a funzionare.',
    hiddenBodyAlways: '{app} resta attivo nell’area di notifica. Per chiuderlo usa «Esci» dal suo menu.',
    startFailedTitle: 'Un server non è partito',
    startFailedBody: '«{name}» non è partito. Apri {app} per vedere perché.',
    quitTitle: 'Uscire da {app}?',
    quitOne: 'C’è un server acceso. Uscendo lo fermo e gli altri programmi non potranno più usarlo.',
    quitMany: 'Ci sono {n} server accesi. Uscendo li fermo e gli altri programmi non potranno più usarli.',
    quitConfirm: 'Ferma ed esci',
    quitCancel: 'Annulla',
  },
  en: {
    open: 'Open {app}',
    server: '{model} · port {port}',
    serverLoading: '{model} · port {port} · starting…',
    serverLan: '{model} · port {port} · local network',
    copy: 'Copy address',
    stop: 'Stop (unload model)',
    restart: 'Restart',
    startPreset: 'Start preset',
    noPresets: 'No saved presets',
    presetPort: '{name} · port {port}',
    presetRunning: '{name} · already running',
    stopAll: 'Stop all servers',
    quit: 'Quit',
    tooltipIdle: '{app}',
    tooltipOne: '{app} · 1 server running: {list}',
    tooltipMany: '{app} · {n} servers running: {list}',
    tooltipLoading: '{model} starting',
    hiddenTitle: '{app} is still running',
    hiddenBody: '{app} stays in the notification area: the server keeps running.',
    hiddenBodyAlways: '{app} stays in the notification area. To close it, use “Quit” in its menu.',
    startFailedTitle: 'A server did not start',
    startFailedBody: '“{name}” did not start. Open {app} to see why.',
    quitTitle: 'Quit {app}?',
    quitOne: 'A server is running. Quitting stops it and other programs can no longer use it.',
    quitMany: '{n} servers are running. Quitting stops them and other programs can no longer use them.',
    quitConfirm: 'Stop and quit',
    quitCancel: 'Cancel',
  },
} as const;

export type TrayLang = keyof typeof TRAY_TEXT;
export type TrayTextKey = keyof (typeof TRAY_TEXT)['it'];

/** The text of `key` in `lang`, with {name} placeholders filled in ({app} is the product's name). */
export function trayText(lang: TrayLang, key: TrayTextKey, params: Record<string, string | number> = {}): string {
  const all: Record<string, string | number> = { app: APP_NAME, ...params };
  return TRAY_TEXT[lang][key].replace(/\{(\w+)\}/g, (m, name: string) => (name in all ? String(all[name]) : m));
}
