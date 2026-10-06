import { serve, type ServerType } from '@hono/node-server';
import type { AddressInfo } from 'node:net';
import type { CoreContext } from './context';
import type { CoreDeps } from './deps';
import { createApp, type RouteModule } from './server/app';
import { EventHub } from './server/event-hub';
import { SettingsRepo } from './store/settings-repo';
import { createSysInfo } from './sysinfo/fingerprint';
import { createTelemetry } from './telemetry/factory';

export interface CoreHandle {
  ctx: CoreContext;
  port: number;
  url: string;
  close(): Promise<void>;
}

export interface CoreOptions {
  token: string;
  /** 0 = pick a free port. */
  port?: number;
  modules?: RouteModule[];
  sseHeartbeatMs?: number;
}

/** Composition root: builds every service from the injected deps and starts the HTTP server on 127.0.0.1. */
export async function createCore(deps: CoreDeps, opts: CoreOptions): Promise<CoreHandle> {
  const shutdown = new AbortController();
  const telemetry = createTelemetry(deps);
  const ctx: CoreContext = {
    deps,
    hub: new EventHub(),
    settings: new SettingsRepo(deps.paths.dataDir),
    shutdown: shutdown.signal,
    secrets: deps.env.GPUBENCH_HF_TOKEN ? { hfToken: deps.env.GPUBENCH_HF_TOKEN } : {},
    telemetry,
    sysinfo: createSysInfo(deps, { telemetry }),
  };
  let boundPort = 0;
  const app = createApp(ctx, {
    token: opts.token,
    port: () => boundPort,
    modules: opts.modules ?? [],
    ...(opts.sseHeartbeatMs ? { sseHeartbeatMs: opts.sseHeartbeatMs } : {}),
  });

  const server: ServerType = await new Promise((resolve, reject) => {
    const s = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: opts.port ?? 0 }, () => resolve(s));
    s.once('error', reject);
  });
  boundPort = (server.address() as AddressInfo).port;
  deps.log.info('core listening', { port: boundPort });

  return {
    ctx,
    port: boundPort,
    url: `http://127.0.0.1:${boundPort}`,
    close: () =>
      new Promise<void>((resolve) => {
        shutdown.abort();
        server.close(() => resolve());
        // SSE streams keep connections open: drop them so close() completes.
        (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
      }),
  };
}
