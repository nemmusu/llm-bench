import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import type { ServerEvent } from '../../contract/events';
import type { ApiClient } from './api';

const ApiContext = createContext<ApiClient | null>(null);

export function ApiProvider({ api, children }: { api: ApiClient; children: ReactNode }) {
  return <ApiContext.Provider value={api}>{children}</ApiContext.Provider>;
}

export function useApi(): ApiClient {
  const api = useContext(ApiContext);
  if (!api) throw new Error('useApi must be used inside <ApiProvider>');
  return api;
}

type Listener = (e: ServerEvent) => void;

interface EventsValue {
  connected: boolean;
  subscribe(listener: Listener): () => void;
}

const EventsContext = createContext<EventsValue>({ connected: false, subscribe: () => () => undefined });

/**
 * One SSE connection for the whole app; screens subscribe to the events they need.
 * `connected` drives the core status dot in the sidebar.
 */
export function EventsProvider({ children }: { children: ReactNode }) {
  const api = useApi();
  const [connected, setConnected] = useState(false);
  const listeners = useRef(new Set<Listener>());
  const [value] = useState<Omit<EventsValue, 'connected'>>(() => ({
    subscribe(listener: Listener) {
      listeners.current.add(listener);
      return () => listeners.current.delete(listener);
    },
  }));

  useEffect(
    () =>
      api.events(
        (e) => {
          for (const l of listeners.current) l(e);
        },
        (ok) => setConnected(ok),
      ),
    [api],
  );

  return <EventsContext.Provider value={{ connected, subscribe: value.subscribe }}>{children}</EventsContext.Provider>;
}

/** True while the SSE stream to the core is open. */
export function useCoreConnected(): boolean {
  return useContext(EventsContext).connected;
}

/** Calls `handler` for every server event while the component is mounted. */
export function useServerEvents(handler: Listener): void {
  const { subscribe } = useContext(EventsContext);
  const ref = useRef(handler);
  // Keep the latest handler without re-subscribing (refs are written outside render).
  useEffect(() => {
    ref.current = handler;
  });
  useEffect(() => subscribe((e) => ref.current(e)), [subscribe]);
}
