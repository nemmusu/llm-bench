import type { RouteModule } from './server/app';

/**
 * Every feature registers its HTTP routes here. Each module lives in its own folder
 * (e.g. ./models/routes.ts) and receives the shared CoreContext.
 */
export const allModules: RouteModule[] = [];
