import { describe, expect, it } from 'vitest';
import { launchParamsSchema } from '../../../../src/contract/engines';
import { displayCommand, redactArgv, redactEnv } from '../../../../src/core/engines/command-display';
import { toLaunchRecord, weightFiles, type LaunchPlan, type ModelTarget } from '../../../../src/core/engines/types';

describe('weightFiles', () => {
  const identity: ModelTarget['identity'] = { displayName: 'M', format: 'gguf', source: 'hf', files: [], weakKey: 'w' };
  const local: NonNullable<ModelTarget['local']> = {
    id: 'm',
    identity,
    paths: ['/m/a-00001-of-00002.gguf', '/m/a-00002-of-00002.gguf', '/m/mmproj.gguf'],
    auxiliary: [{ kind: 'mmproj', path: '/m/mmproj.gguf' }],
    dir: '/m',
    origin: 'library',
    modifiedAt: '',
  };
  const pending = { repo: 'o/r', file: 'a.gguf', paths: ['/lib/o/r/a.gguf'], bytes: 10 };

  it('loads the local weights only (never auxiliaries)', () => {
    expect(weightFiles({ identity, local }, true)).toEqual({ files: ['/m/a-00001-of-00002.gguf', '/m/a-00002-of-00002.gguf'], pending: false });
  });

  it('uses a pending download only in a preview', () => {
    expect(weightFiles({ identity, pending }, true)).toEqual({ files: ['/lib/o/r/a.gguf'], pending: true });
    expect(weightFiles({ identity, pending })).toEqual({ files: [], pending: false });
    expect(weightFiles({ identity }, true)).toEqual({ files: [], pending: false });
  });
});

describe('toLaunchRecord', () => {
  const plan: LaunchPlan = {
    kind: 'llamacpp-native',
    argv: ['/opt/llama-server', '--api-key', 'sk-secret', '--port', '8080'],
    env: { HF_TOKEN: 'hf_x' },
    host: '127.0.0.1',
    port: 8080,
    params: launchParamsSchema.parse({}),
    engine: { kind: 'llamacpp-native', name: 'llama.cpp' },
    modelFiles: [],
    modelBytes: 0,
    marker: 'gpubench-0000000000',
  };

  it('keeps cwd only when set; pairs with redaction for storage', () => {
    const safe = { ...plan, argv: redactArgv(plan.argv), env: redactEnv(plan.env) };
    const rec = toLaunchRecord(safe, displayCommand(safe.argv, safe.env));
    expect(rec).not.toHaveProperty('cwd');
    expect(JSON.stringify(rec)).not.toMatch(/sk-secret|hf_x/);
    expect(rec.display.bash).toBe("HF_TOKEN='<HF_TOKEN>' /opt/llama-server --api-key '<API_KEY>' --port 8080");
    expect(toLaunchRecord({ ...safe, cwd: '/w' }, rec.display).cwd).toBe('/w');
  });
});
