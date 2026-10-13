import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { APP_NOTICES_FILE, parseAppNotices, type AppNotice } from '../../contract/app-notices';
import type { RouteModule } from '../server/app';

/**
 * The app's one-time notices (contract/app-notices.ts), written by the Electron main process before
 * the core starts:
 *   GET    /api/app/notices       -> AppNotice[]
 *   DELETE /api/app/notices/:id   -> { ok: true }   (shown: never again)
 * A tiny file read and written synchronously: two dismissals at once cannot interleave.
 */
export function createAppNoticeRoutes(): RouteModule {
  return (app, ctx) => {
    const file = path.join(ctx.deps.paths.dataDir, APP_NOTICES_FILE);
    const read = (): AppNotice[] => {
      try {
        return parseAppNotices(JSON.parse(readFileSync(file, 'utf8')));
      } catch {
        return [];
      }
    };
    app.get('/api/app/notices', (c) => c.json(read()));
    app.delete('/api/app/notices/:id', (c) => {
      const all = read();
      const rest = all.filter((n) => n.id !== c.req.param('id'));
      if (rest.length !== all.length) writeFileSync(file, JSON.stringify(rest, null, 2));
      return c.json({ ok: true as const });
    });
  };
}
