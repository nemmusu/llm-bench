import type { ServerEvent } from '../../contract/events';

export type EventListener = (e: ServerEvent) => void;

/** In-process pub/sub feeding the SSE endpoint. Listeners must not throw. */
export class EventHub {
  private listeners = new Set<EventListener>();

  publish(e: ServerEvent): void {
    for (const l of this.listeners) {
      try {
        l(e);
      } catch {
        /* a broken subscriber must not break the publisher */
      }
    }
  }

  subscribe(l: EventListener): () => void {
    this.listeners.add(l);
    return () => {
      this.listeners.delete(l);
    };
  }

  get size(): number {
    return this.listeners.size;
  }
}
