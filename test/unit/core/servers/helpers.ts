import { DEFAULT_SERVER_PORT } from '../../../../src/contract/servers';
import type { ServerPorts } from '../../../../src/core/servers/ports';

/** Ports in memory: `busy` are taken by other programs (a user's own llama-server…). */
export function fakePorts(busy: number[] = []): ServerPorts & { busy: Set<number> } {
  const taken = new Set(busy);
  return {
    busy: taken,
    free: async (port) => !taken.has(port),
    suggest: async (ours) => {
      let p = DEFAULT_SERVER_PORT;
      while (ours.includes(p) || taken.has(p)) p++;
      return p;
    },
  };
}

export const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));
