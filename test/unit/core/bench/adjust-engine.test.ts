import { afterEach, describe, expect, it } from 'vitest';
import type { EngineConfig } from '../../../../src/contract/engines';
import { BenchService } from '../../../../src/core/bench/service';
import { request, serviceSetup, TempDirs } from './service-helpers';

const tmp = new TempDirs();
afterEach(() => tmp.cleanup());

describe('adjustEngine', () => {
  it('plans and runs with the adjusted engine configuration', async () => {
    const s = serviceSetup(tmp);
    const seen: EngineConfig[] = [];
    const plan = s.adapter.plan.bind(s.adapter);
    s.adapter.plan = (cfg, ...rest) => {
      seen.push(cfg);
      return plan(cfg, ...rest);
    };
    const svc = new BenchService({ ...s.deps, adjustEngine: async (req) => ({ ...req.engine, modelVolume: 'gpubench-model-m1' }) });
    await svc.plan(request());
    await svc.start(request());
    await svc.whenIdle();
    // plan(), start() and the runner all see the adjusted configuration.
    expect(seen.length).toBeGreaterThanOrEqual(2);
    expect(seen.every((c) => c.modelVolume === 'gpubench-model-m1')).toBe(true);
  });

  it('keeps the request engine when there is nothing to adjust', async () => {
    const s = serviceSetup(tmp);
    const seen: EngineConfig[] = [];
    const plan = s.adapter.plan.bind(s.adapter);
    s.adapter.plan = (cfg, ...rest) => {
      seen.push(cfg);
      return plan(cfg, ...rest);
    };
    const svc = new BenchService({ ...s.deps, adjustEngine: async () => undefined });
    await svc.plan(request());
    expect(seen[0]).toEqual({ kind: 'llamacpp-native' });
  });
});
