import { describe, expect, it } from 'vitest';
import { launchParamsSchema } from '../../../../src/contract/engines';
import { displayCommand, redactArgv, redactEnv } from '../../../../src/core/engines/command-display';
import { toLaunchRecord, type LaunchPlan } from '../../../../src/core/engines/types';

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
