import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { StartRunRequest } from '../../../../src/contract/api';
import { startRunRequestSchema } from '../../../../src/contract/api';
import type { BenchServiceDeps } from '../../../../src/core/bench/service';
import { RunsRepo } from '../../../../src/core/store/runs-repo';
import { hardware } from '../store/fixtures';
import { displayCommand, events, FakeAdapter, FakeTelemetry, modelTarget, SMALL_CORPUS, World, type AdapterOptions, type TelemetryOptions } from './fakes';

export class TempDirs {
  private dirs: string[] = [];
  make(prefix = 'gb-svc-'): string {
    const d = mkdtempSync(path.join(os.tmpdir(), prefix));
    this.dirs.push(d);
    return d;
  }
  cleanup(): void {
    for (const d of this.dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  }
}

/** resources/ with a small corpus and the real score reference. */
export function resourcesDir(tmp: TempDirs, opts: { corpus?: boolean } = {}): string {
  const dir = tmp.make('gb-res-');
  if (opts.corpus !== false) {
    mkdirSync(path.join(dir, 'corpus'));
    writeFileSync(path.join(dir, 'corpus', 'corpus.txt'), SMALL_CORPUS);
  }
  copyFileSync(path.resolve('resources', 'score-reference.json'), path.join(dir, 'score-reference.json'));
  return dir;
}

export interface ServiceSetup {
  adapter?: AdapterOptions;
  telemetry?: TelemetryOptions;
  deps?: Partial<BenchServiceDeps>;
  corpus?: boolean;
}

export function serviceSetup(tmp: TempDirs, o: ServiceSetup = {}) {
  const world = new World();
  const adapter = new FakeAdapter(world, o.adapter);
  const telemetry = new FakeTelemetry(world, o.telemetry);
  const resultsDir = tmp.make('gb-results-');
  const runs = new RunsRepo(() => resultsDir);
  const ev = events();
  let ports = 40000;
  const deps: BenchServiceDeps = {
    clock: world.clock,
    runs,
    publish: ev.publish,
    telemetry,
    fingerprint: async () => hardware(),
    displayCommand,
    getAdapter: () => adapter,
    resolveModel: async () => modelTarget(),
    pickPort: async () => ports++,
    appVersion: '0.1.0-test',
    cacheDir: tmp.make('gb-cache-'),
    resourcesDir: resourcesDir(tmp, o.corpus === false ? { corpus: false } : {}),
    ownPids: () => [],
    ...o.deps,
  };
  return { world, adapter, telemetry, runs, ev, deps, resultsDir };
}

export function request(over: Partial<Record<keyof StartRunRequest, unknown>> = {}): StartRunRequest {
  return startRunRequestSchema.parse({ engine: { kind: 'llamacpp-native' }, model: { localId: 'm1' }, profile: 'quick', ...over });
}
