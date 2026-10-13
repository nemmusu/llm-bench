import type { CloseBehavior } from '../contract/servers';

/** What closing the window does. */
export type CloseAction = 'quit' | 'hide' | 'minimize';

export interface CloseInput {
  /** GPU Bench is quitting ("Esci", the OS logging out, a test closing the app): always let the window go. */
  quitting: boolean;
  /** settings.closeBehavior ("Alla chiusura della finestra"). */
  behavior: CloseBehavior;
  /** Servers GPU Bench started that are running (or starting). */
  servers: number;
  /** A tray icon is shown (some Linux desktops have no notification area). */
  tray: boolean;
}

/**
 * "Resta nell'area di notifica se c'è un server attivo" (default), "Sempre" or "Esci sempre". Hiding
 * needs a tray icon to come back from: without one the window is minimized instead.
 */
export function closeAction(o: CloseInput): CloseAction {
  if (o.quitting || o.behavior === 'quit') return 'quit';
  if (o.behavior === 'tray-if-servers' && o.servers === 0) return 'quit';
  return o.tray ? 'hide' : 'minimize';
}

/** The one-time "GPU Bench resta attivo nell'area di notifica" notification: the first time the window hides. */
export function shouldExplainHide(action: CloseAction, alreadyShown: boolean): boolean {
  return action === 'hide' && !alreadyShown;
}

/** Started at login ("--hidden"): stay in the tray, or minimized when there is no tray. Else show the window. */
export function startupWindow(o: { hiddenStart: boolean; tray: boolean }): 'show' | 'hide' | 'minimize' {
  if (!o.hiddenStart) return 'show';
  return o.tray ? 'hide' : 'minimize';
}
