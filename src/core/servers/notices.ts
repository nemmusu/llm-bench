import { randomUUID } from 'node:crypto';
import { toAppErrorData } from '../../contract/errors';
import type { ServerNotice } from '../../contract/servers';

/** Keeps the latest ones: a preset that fails at every start must not pile up forever. */
const MAX_NOTICES = 20;

/**
 * Starts that failed while nobody was looking ("Avvia all'apertura", a preset started from the tray):
 * the Server page shows them until they are dismissed. In memory: a new session starts clean.
 */
export class ServerNotices {
  private items: ServerNotice[] = [];

  constructor(private readonly o: { now: () => number; newId?: () => string; onChange?: () => void }) {}

  /** `what`: the preset that failed, or (a server restarted from the tray) just its name. */
  add(kind: ServerNotice['kind'], what: { id?: string; name: string }, error: unknown): ServerNotice {
    const notice: ServerNotice = {
      id: this.o.newId?.() ?? randomUUID(),
      kind,
      ...(what.id !== undefined ? { presetId: what.id } : {}),
      name: what.name,
      error: toAppErrorData(error),
      at: new Date(this.o.now()).toISOString(),
    };
    // A newer failure of the same preset replaces the older one.
    this.items = [notice, ...this.items.filter((n) => what.id === undefined || n.presetId !== what.id)].slice(0, MAX_NOTICES);
    this.o.onChange?.();
    return notice;
  }

  list(): ServerNotice[] {
    return [...this.items];
  }

  dismiss(id: string): void {
    const before = this.items.length;
    this.items = this.items.filter((n) => n.id !== id);
    if (this.items.length !== before) this.o.onChange?.();
  }

  /** A preset started fine after all: its old failure is no longer news. */
  clearPreset(presetId: string): void {
    const before = this.items.length;
    this.items = this.items.filter((n) => n.presetId !== presetId);
    if (this.items.length !== before) this.o.onChange?.();
  }
}
