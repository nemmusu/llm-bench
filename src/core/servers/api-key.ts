import { randomBytes } from 'node:crypto';
import type { ServerApiKeyInfo, ServerApiKeyStorage } from '../../contract/servers';

/** A new key: "gpub-" and 32 URL-safe random characters (192 bits). */
export function newServerApiKey(random: (bytes: number) => Buffer = randomBytes): string {
  return `gpub-${random(24).toString('base64url')}`;
}

export interface ServerKeysOptions {
  random?: (bytes: number) => Buffer;
}

/**
 * The API key of servers shared on the local network. One key for every network server, made by
 * LLM Bench the first time it is needed, shown to the user (to paste in other devices), kept by the
 * Electron main process (encrypted), never written to settings, logs or stored commands.
 */
export class ServerKeys {
  private key: string | undefined;
  private storage: ServerApiKeyStorage = 'memory';
  /** Every key handed out in this session: a server keeps the key it was started with until it restarts. */
  private readonly issued = new Set<string>();
  private persist: ((key: string) => void) | undefined;

  constructor(private readonly o: ServerKeysOptions = {}) {}

  /**
   * Keeps new keys across restarts: inside Electron the main process saves them encrypted (safeStorage)
   * and confirms with `restore(key, storage)`. Never set in browser mode: the key lives for this session.
   */
  persistWith(fn: (key: string) => void): void {
    this.persist = fn;
  }

  /** The saved key, from the main process at start-up, or its confirmation that a new key was saved. */
  restore(key: string, storage: Exclude<ServerApiKeyStorage, 'memory'>): void {
    // A key made in this session before the saved one arrived stays: it may already be in use.
    if (this.key !== undefined && this.key !== key) return;
    this.key = key;
    this.storage = storage;
    this.issued.add(key);
  }

  /** The current key, made (and handed to the main process to save) the first time. */
  current(): ServerApiKeyInfo {
    if (this.key === undefined) this.replace();
    return { key: this.key as string, storage: this.storage };
  }

  /** "Genera una nuova chiave": servers already running keep the old one until they restart. */
  regenerate(): ServerApiKeyInfo {
    this.replace();
    return this.current();
  }

  /** Every key of this session, for hiding them in engine output. */
  secrets(): string[] {
    return [...this.issued];
  }

  private replace(): void {
    const key = newServerApiKey(this.o.random);
    this.key = key;
    this.storage = 'memory';
    this.issued.add(key);
    this.persist?.(key);
  }
}
