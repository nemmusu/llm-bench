import { afterEach, describe, expect, it } from 'vitest';
import type { ActiveRun } from '../../../../src/contract/api';
import type { ServerEvent } from '../../../../src/contract/events';
import { BenchService, livePointKey } from '../../../../src/core/bench/service';
import { aggregateSessions } from '../../../../src/core/bench/steps/sessions';
import { hardware, makeRun } from '../store/fixtures';
import { request, serviceSetup, TempDirs } from './service-helpers';

const tmp = new TempDirs();
afterEach(() => tmp.cleanup());

describe('BenchService: what the engine is doing while it starts', () => {
  it('the active run shows the latest run.load until the engine answers, with the usual load time of this model', async () => {
    const ref: { svc?: BenchService } = {};
    const seen: (ActiveRun['loading'] | 'none')[] = [];
    const s = serviceSetup(tmp, {
      adapter: { instance: { logs: ['llama_model_loader: loaded meta data with 35 key-value pairs', 'load_tensors: loading model tensors'] } },
    });
    const publish = s.deps.publish;
    s.deps.publish = (e: ServerEvent) => {
      publish(e);
      if (e.type === 'run.load') seen.push(ref.svc?.active()?.loading ?? 'none');
    };
    await s.runs.save(makeRun({ id: 'past' }));
    const svc = (ref.svc = new BenchService(s.deps));
    await svc.start(request());
    await svc.whenIdle();
    const loads = s.ev.ofType('run.load');
    expect(loads[0]).toMatchObject({ stage: 'starting', expectedMs: 1500 });
    expect(loads.at(-1)?.stage).toBe('ready');
    expect(seen[0]).toMatchObject({ stage: 'starting', elapsedMs: 0, expectedMs: 1500 });
    expect(seen[0]).not.toHaveProperty('type');
    expect(seen[0]).not.toHaveProperty('runId');
    // Ready: nothing is starting any more.
    expect(seen.at(-1)).toBe('none');
  });

  it('usual load time: same engine kind, completed, on this PC; cold and warm separately; unknown is absent', async () => {
    const s = serviceSetup(tmp);
    const svc = new BenchService(s.deps);
    const model = { identity: makeRun().model };
    expect(await svc.expectedLoad(model, 'llamacpp-native')).toEqual({});
    const coldOnly = makeRun({ id: 'cold-only' });
    coldOnly.metrics = { ...coldOnly.metrics, load: { coldMs: coldOnly.metrics.load.coldMs, phases: [] } };
    await s.runs.save(coldOnly);
    await s.runs.save(makeRun({ id: 'vllm', engine: { kind: 'vllm-docker', name: 'vLLM' } }));
    await s.runs.save(makeRun({ id: 'failed', status: 'failed' }));
    await s.runs.save(makeRun({ id: 'elsewhere', hardware: hardware({ hostId: 'other' }) }));
    expect(await svc.expectedLoad(model, 'llamacpp-native')).toEqual({ expectedLoadMs: { cold: 9000 } });
    await s.runs.save(makeRun({ id: 'warm' }));
    expect(await svc.expectedLoad(model, 'llamacpp-native')).toEqual({ expectedLoadMs: { cold: 9000, warm: 1500 } });
    // The PC cannot be identified: simply unknown.
    const t = serviceSetup(tmp, { deps: { fingerprint: async () => Promise.reject(new Error('wmi')) } });
    expect(await new BenchService(t.deps).expectedLoad(model, 'llamacpp-native')).toEqual({});
  });

  it('servers: the usual (warm) load time comes with a real start, not with a preview', async () => {
    const s = serviceSetup(tmp);
    await s.runs.save(makeRun({ id: 'past' }));
    const svc = new BenchService(s.deps);
    const req = { engine: { kind: 'llamacpp-native' as const }, model: { localId: 'm1' } };
    expect((await svc.prepareServer(req, { preview: false, marker: 'gpubench-x' })).expectedLoadMs).toBe(1500);
    expect((await svc.prepareServer(req, { preview: true, marker: 'gpubench-x' })).expectedLoadMs).toBeUndefined();
    const cold = makeRun({ id: 'cold' });
    cold.metrics = { ...cold.metrics, load: { coldMs: cold.metrics.load.coldMs, phases: [] } };
    const c = serviceSetup(tmp);
    await c.runs.save(cold);
    expect((await new BenchService(c.deps).prepareServer(req, { preview: false, marker: 'gpubench-y' })).expectedLoadMs).toBe(9000);
  });

  it('a long-conversation point replaces the earlier one of the same level', () => {
    const point = aggregateSessions({ depth: 1000, turns: 2, outputTokens: 4, followupTokens: 8 }, 2, [], { requests: 0, errors: 0 });
    expect(livePointKey({ stepKind: 'sessions', point })).toBe('sessions:2');
  });
});
