import { DEFAULT_SERVER_PORT } from '../../contract/servers';
import { isPortFree, LOOPBACK, pickFreePort } from '../process/ports';

/** Ports tried from 8080 before giving up on a round number (then the OS picks one). */
export const SUGGEST_SPAN = 100;

export interface ServerPorts {
  /** Nothing listens on `port` at 127.0.0.1 (another program's server, a user's own llama-server…). */
  free(port: number): Promise<boolean>;
  /** The first free port from 8080 that none of `taken` (our own servers, starting ones included) uses. */
  suggest(taken: readonly number[]): Promise<number>;
}

/**
 * Real ports, checked by binding 127.0.0.1 for a moment. Never by listening on 0.0.0.0: Windows asks
 * about its firewall the first time a program listens on every card, and a preview must not do that.
 * A program already on 0.0.0.0 of the same port is still found where the OS says so (Linux), and
 * otherwise when the engine cannot bind it (the adapters report "address in use").
 */
export function systemPorts(isFree: (port: number, host: string) => Promise<boolean> = isPortFree, fallback: () => Promise<number> = pickFreePort): ServerPorts {
  const free = (port: number) => isFree(port, LOOPBACK);
  return {
    free,
    async suggest(taken) {
      for (let p = DEFAULT_SERVER_PORT; p < DEFAULT_SERVER_PORT + SUGGEST_SPAN; p++) if (!taken.includes(p) && (await free(p))) return p;
      return fallback();
    },
  };
}
