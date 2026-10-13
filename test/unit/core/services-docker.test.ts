import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ServerInfo } from '../../../src/contract/api';
import type { ProcessRunner } from '../../../src/core/deps';
import type { DockerControlDeps } from '../../../src/core/docker/control';
import { createServices, serviceModules } from '../../../src/core/services';
import type { ServeServiceDeps } from '../../../src/core/servers/service';
import { createApp } from '../../../src/core/server/app';
import { tempDir, testContext, testDeps } from './server/helpers';

describe('createServices: Docker control', () => {
  let t: ReturnType<typeof tempDir>;
  beforeEach(() => {
    t = tempDir();
  });
  afterEach(() => t.cleanup());

  const quietProc: ProcessRunner = {
    run: () => Promise.resolve({ code: 1, stdout: '', stderr: '', timedOut: false }),
    spawn: () => {
      throw new Error('no spawn');
    },
  };

  it('wires the control to the servers, the benchmark, the API endpoint and the timings of the environment', async () => {
    const ctx = testContext(testDeps(t.dir, { proc: quietProc, env: { GPUBENCH_DOCKER_TIMINGS: JSON.stringify({ activeEveryMs: 1234 }) } }));
    const s = await createServices(ctx, { modelServices: false });
    const d = (s.dockerControl as unknown as { o: DockerControlDeps }).o;
    expect(d.activeEveryMs).toBe(1234);
    expect(d.dockerRunActive?.()).toBe(false);
    const bench = s.bench as unknown as { active: () => unknown };
    bench.active = () => ({ launch: { command: { argv: ['docker', 'run', '--label', 'gpubench=1', 'img'] } } });
    expect(d.dockerRunActive?.()).toBe(true);
    bench.active = () => ({ launch: { command: { argv: ['llama-server', '-m', 'x'] } } });
    expect(d.dockerRunActive?.()).toBe(false);
    d.resetApi?.();
    const events: string[] = [];
    ctx.hub.subscribe((e) => events.push(e.type));
    d.publish({ type: 'docker.changed', state: 'running' });
    expect(events).toEqual(['docker.changed']);
    // A server that ended on its own goes to the control (a llama.cpp one is not Docker's business).
    const serve = (s.serve as unknown as { deps: ServeServiceDeps }).deps;
    serve.onEnded?.({ engineKind: 'llamacpp-native', id: 'x' } as ServerInfo);
    expect(s.dockerControl.recovery().servers).toEqual([]);
  });

  it('serves the diagnosis (what LLM Bench saw when Docker is stuck) and the recovery', async () => {
    const ctx = testContext(testDeps(t.dir, { proc: quietProc, platform: 'linux' }));
    const s = await createServices(ctx, { modelServices: false });
    const app = createApp(ctx, { token: 't', port: () => 1, modules: serviceModules(s) });
    const get = (p: string) => app.request(p, { headers: { authorization: 'Bearer t', host: '127.0.0.1:1' } });
    expect(await (await get('/api/docker/diagnosis')).json()).toEqual({ cause: 'unknown', evidence: [] });
    await s.docker.env.status();
    s.docker.env.reportHang('stuck');
    expect(await (await get('/api/docker/diagnosis')).json()).toEqual({ cause: 'not-answering', evidence: [] });
    expect(await (await get('/api/docker/recovery')).json()).toEqual({ servers: [], restoring: false });
  });
});
