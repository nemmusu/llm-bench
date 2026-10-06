import { AppError } from '../../contract/errors';
import type { CoreContext } from '../context';
import type { RouteModule } from '../server/app';
import { SETUP_JOB_KINDS, type SetupJobKind, type SetupService } from './service';

/**
 *   GET  /api/setup/check[?fresh=1]          -> SystemCheckReport (fresh=1 forgets cached detections first)
 *   GET  /api/setup/driver                   -> DriverCheckResult
 *   GET  /api/setup/docker/plan              -> DockerInstallPlan (Windows: installer URL + size + WSL; Linux: distro support + argv)
 *   POST /api/setup/docker/install           -> 202 { started, job } (progress: engine.install events, kind docker-desktop | docker-linux)
 *   GET  /api/setup/docker/linux-script      -> { script, steps } (the exact text pkexec runs)
 *   POST /api/setup/uv/install               -> 202 { started, job } (progress: engine.install events, kind uv)
 *   GET  /api/setup/jobs                     -> SetupJob[]
 *   POST /api/setup/jobs/:kind/cancel        -> SetupJob
 *
 * Accepts the service or a factory receiving the CoreContext (modules.ts is built before the context exists).
 */
export function createSetupRoutes(svc: SetupService | ((ctx: CoreContext) => SetupService)): RouteModule {
  return (app, ctx) => {
    const s = typeof svc === 'function' ? svc(ctx) : svc;
    app.get('/api/setup/check', async (c) => c.json(await s.check({ fresh: c.req.query('fresh') === '1' })));
    app.get('/api/setup/driver', async (c) => c.json(await s.driver()));
    app.get('/api/setup/docker/plan', async (c) => c.json(await s.dockerPlan()));
    app.post('/api/setup/docker/install', (c) => c.json(s.startDockerInstall(), 202));
    app.get('/api/setup/docker/linux-script', (c) => c.json(s.linuxScript()));
    app.post('/api/setup/uv/install', (c) => c.json(s.startUvInstall(), 202));
    app.get('/api/setup/jobs', (c) => c.json(s.jobs()));
    app.post('/api/setup/jobs/:kind/cancel', (c) => {
      const kind = c.req.param('kind');
      if (!(SETUP_JOB_KINDS as readonly string[]).includes(kind)) throw new AppError('VALIDATION', `Unknown setup job: ${kind}`);
      const job = s.cancel(kind as SetupJobKind);
      if (!job) throw new AppError('VALIDATION', `No ${kind} job`, { params: { reason: 'no-job' } });
      return c.json(job);
    });
  };
}
