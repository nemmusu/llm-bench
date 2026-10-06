import type { RouteModule } from './server/app';
import { createSystemService } from './system/service';
import { createSystemRoutes } from './system/routes';

/**
 * Every feature registers its HTTP routes here. Each module lives in its own folder
 * (e.g. ./models/routes.ts) and receives the shared CoreContext.
 */
export const allModules: RouteModule[] = [
  createSystemRoutes((ctx) =>
    createSystemService({
      paths: ctx.deps.paths,
      clock: ctx.deps.clock,
      settings: ctx.settings,
      telemetry: ctx.telemetry,
      sysinfo: ctx.sysinfo,
      log: ctx.deps.log,
    }),
  ),
];
