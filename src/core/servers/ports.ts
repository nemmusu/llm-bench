import { DEFAULT_SERVER_PORT } from '../../contract/servers';
import { isPortFree, LOOPBACK, pickFreePort } from '../process/ports';
import { LAN_HOST } from './lan';

/** Ports tried from 8080 before giving up on a round number (then the OS picks one). */
export const SUGGEST_SPAN = 100;

export interface ServerPorts {
  /** Nothing listens on `port`, on 127.0.0.1 nor on every card (another program's server, a user's own llama-server…). */
  free(port: number): Promise<boolean>;
  /** The first free port from 8080 that none of `taken` (our own servers, starting ones included) uses. */
  suggest(taken: readonly number[]): Promise<number>;
}

/**
 * Real ports. A port counts as free only when both 127.0.0.1 and 0.0.0.0 can be bound: on Windows a
 * server on 0.0.0.0 does not stop another program from binding 127.0.0.1, and the two would collide.
 */
export function systemPorts(isFree: (port: number, host: string) => Promise<boolean> = isPortFree, fallback: () => Promise<number> = pickFreePort): ServerPorts {
  const free = async (port: number) => (await isFree(port, LOOPBACK)) && (await isFree(port, LAN_HOST));
  return {
    free,
    async suggest(taken) {
      for (let p = DEFAULT_SERVER_PORT; p < DEFAULT_SERVER_PORT + SUGGEST_SPAN; p++) if (!taken.includes(p) && (await free(p))) return p;
      return fallback();
    },
  };
}
