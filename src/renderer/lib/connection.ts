import type { DesktopBridge } from '../../contract/bridge';

declare global {
  interface Window {
    gpubench?: DesktopBridge;
  }
}

export interface Connection {
  baseUrl: string;
  token: string;
}

const STORAGE_KEY = 'gpubench.token';

/**
 * Electron: the preload hands over the core URL and session token.
 * Browser mode (tests, headless): the core prints `/?token=…`; we keep it in sessionStorage
 * and strip it from the address bar.
 */
export async function resolveConnection(win: Window = window): Promise<Connection> {
  if (win.gpubench) return win.gpubench.connection();
  const url = new URL(win.location.href);
  const fromQuery = url.searchParams.get('token');
  if (fromQuery) {
    try {
      win.sessionStorage.setItem(STORAGE_KEY, fromQuery);
    } catch {
      /* storage may be unavailable */
    }
    url.searchParams.delete('token');
    win.history.replaceState(null, '', url.pathname + url.search + url.hash);
  }
  let token = fromQuery;
  if (!token) {
    try {
      token = win.sessionStorage.getItem(STORAGE_KEY);
    } catch {
      token = null;
    }
  }
  return { baseUrl: url.origin, token: token ?? '' };
}
