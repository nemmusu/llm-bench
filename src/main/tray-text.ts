/**
 * Words of the tray icon, its menu and the main process's notifications and dialogs, in both
 * languages (the renderer's i18n lives in another process). Keys are identical in it and en.
 */
export const TRAY_TEXT = {
  it: {
    open: 'Apri GPU Bench',
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
    tooltipIdle: 'GPU Bench',
    tooltipOne: 'GPU Bench · 1 server attivo: {list}',
    tooltipMany: 'GPU Bench · {n} server attivi: {list}',
    tooltipLoading: '{model} si avvia',
    hiddenTitle: 'GPU Bench è ancora attivo',
    hiddenBody: 'GPU Bench resta attivo nell’area di notifica: il server continua a funzionare.',
    hiddenBodyAlways: 'GPU Bench resta attivo nell’area di notifica. Per chiuderlo usa «Esci» dal suo menu.',
    startFailedTitle: 'Un server non è partito',
    startFailedBody: '«{name}» non è partito. Apri GPU Bench per vedere perché.',
    quitTitle: 'Uscire da GPU Bench?',
    quitOne: 'C’è un server acceso. Uscendo lo fermo e gli altri programmi non potranno più usarlo.',
    quitMany: 'Ci sono {n} server accesi. Uscendo li fermo e gli altri programmi non potranno più usarli.',
    quitConfirm: 'Ferma ed esci',
    quitCancel: 'Annulla',
  },
  en: {
    open: 'Open GPU Bench',
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
    tooltipIdle: 'GPU Bench',
    tooltipOne: 'GPU Bench · 1 server running: {list}',
    tooltipMany: 'GPU Bench · {n} servers running: {list}',
    tooltipLoading: '{model} starting',
    hiddenTitle: 'GPU Bench is still running',
    hiddenBody: 'GPU Bench stays in the notification area: the server keeps running.',
    hiddenBodyAlways: 'GPU Bench stays in the notification area. To close it, use “Quit” in its menu.',
    startFailedTitle: 'A server did not start',
    startFailedBody: '“{name}” did not start. Open GPU Bench to see why.',
    quitTitle: 'Quit GPU Bench?',
    quitOne: 'A server is running. Quitting stops it and other programs can no longer use it.',
    quitMany: '{n} servers are running. Quitting stops them and other programs can no longer use them.',
    quitConfirm: 'Stop and quit',
    quitCancel: 'Cancel',
  },
} as const;

export type TrayLang = keyof typeof TRAY_TEXT;
export type TrayTextKey = keyof (typeof TRAY_TEXT)['it'];

/** The text of `key` in `lang`, with {name} placeholders filled in. */
export function trayText(lang: TrayLang, key: TrayTextKey, params: Record<string, string | number> = {}): string {
  return TRAY_TEXT[lang][key].replace(/\{(\w+)\}/g, (m, name: string) => (name in params ? String(params[name]) : m));
}
