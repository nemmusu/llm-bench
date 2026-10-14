// TensorRT-LLM in the composition root: both adapters registered, the HF token handed to them, a test
// launcher for native runs, NGC's tags and "Rimuovi" through the app's routes.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { launchParamsSchema } from '../../../src/contract/engines';
import { createServices, serviceModules } from '../../../src/core/services';
import { createApp } from '../../../src/core/server/app';
import { tempDir, testContext, testDeps } from './server/helpers';

describe('TensorRT-LLM in the services', () => {
  let t: ReturnType<typeof tempDir>;
  beforeEach(() => {
    t = tempDir();
  });
  afterEach(() => t.cleanup());

  it('plans native runs through the test launcher with the HF token, and refuses a removal while a server runs', async () => {
    const ctx = testContext(testDeps(t.dir, { endpoints: { githubApi: 'http://127.0.0.1:9', huggingface: 'http://127.0.0.1:9', dockerHub: 'http://127.0.0.1:9', ngcRegistry: 'http://127.0.0.1:9', trtllmHost: ['node'] } }));
    ctx.secrets.hfToken = 'hf_x';
    const s = await createServices(ctx, { modelServices: false });
    expect(s.registry.get('trtllm-docker')?.kind).toBe('trtllm-docker');
    const native = s.registry.require('trtllm-native');
    const model = { identity: { displayName: 'm', format: 'safetensors' as const, source: 'hf' as const, repo: 'a/b', files: [], weakKey: 'w' }, repo: 'a/b' };
    const plan = await native.plan({ kind: 'trtllm-native' }, model, launchParamsSchema.parse({}), { port: 1, marker: 'gpubench-x', preview: true });
    expect(plan.argv[0]).toBe('node');
    expect(plan.env.HF_TOKEN).toBeDefined();
    const app = createApp(ctx, { token: 't', port: () => 1, modules: serviceModules(s) });
    const headers = { authorization: 'Bearer t', host: '127.0.0.1:1' };
    s.serve.busy = () => true;
    const res = await app.request('/api/engines/trtllm-native/install', { method: 'DELETE', headers });
    expect(await res.json()).toMatchObject({ error: { params: { reason: 'busy' } } });
    // NGC cannot be reached here: said as a network problem.
    expect((await app.request('/api/engines/trtllm/tags', { headers })).status).toBeGreaterThanOrEqual(400);
    const plain = await createServices(testContext(testDeps(t.dir)), { modelServices: false });
    expect((await plain.registry.require('trtllm-native').plan({ kind: 'trtllm-native' }, model, launchParamsSchema.parse({}), { port: 1, marker: 'gpubench-y', preview: true })).argv[0]).not.toBe('node');
  });
});
