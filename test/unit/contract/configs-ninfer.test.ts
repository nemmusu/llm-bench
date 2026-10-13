import { describe, expect, it } from 'vitest';
import { configParamsOf } from '../../../src/contract/configs';
import { launchParamsSchema, type LaunchParams } from '../../../src/contract/engines';

const P = (over: Partial<LaunchParams> = {}): LaunchParams => launchParamsSchema.parse(over);

/** A benchmark launch of NInfer in WSL, as the plan builds it. */
const WSL_ARGV = [
  'wsl.exe',
  '-d',
  'Ubuntu-24.04',
  '--exec',
  '/usr/bin/env',
  'GPUBENCH_OWNER=gpubench-1',
  '/bin/sh',
  '-c',
  'echo "gpubench-pid $$" >&2; exec "$@"',
  'sh',
  '/home/user/ninfer/build/apps/ninfer-serve',
  '/mnt/c/models/qwen3_8_27b_nvfp4.ninfer',
  '--host',
  '127.0.0.1',
  '--port',
  '18090',
  '--model-id',
  'gpubench-1',
  '--max-context',
  '65536',
  '--max-concurrency',
  '2',
  '--kv-capacity',
  '131072',
  '--kv-dtype',
  'int8',
  '--spec',
  'mtp',
  '--draft-tokens',
  '3',
  '--lm-head-draft',
  '--vision',
  '--no-prefix-reuse',
  '--no-thinking',
];

describe('configurations of NInfer', () => {
  it('reads its own arguments after ninfer-serve (the WSL wrapper is not part of it)', () => {
    expect(configParamsOf({ engineKind: 'ninfer-wsl', argv: WSL_ARGV, params: P({ contextSize: 65_536, parallel: 2 }) })).toEqual({
      contextSize: 65_536,
      cacheTypeK: 'int8',
      cacheTypeV: 'int8',
      parallel: 2,
      speculative: '{"lm_head_draft":true,"method":"mtp","num_speculative_tokens":3}',
      other: ['--kv-capacity 131072', '--vision'],
    });
  });

  it('says the same from the launch settings alone (a server made from the same preset)', () => {
    const params = P({ contextSize: 65_536, parallel: 2, ninfer: { kvCapacity: 131_072, kvDtype: 'int8', spec: 'mtp', draftTokens: 3, lmHeadDraft: true, vision: true } });
    expect(configParamsOf({ engineKind: 'ninfer-native', params })).toEqual(configParamsOf({ engineKind: 'ninfer-wsl', argv: WSL_ARGV, params }));
  });

  it('has no speculation with --spec off, and ignores a draft count that is not a number', () => {
    const argv = ['/opt/ninfer/build/apps/ninfer-serve', '/m/a.ninfer', '--spec', 'off', '--draft-tokens', 'many'];
    expect(configParamsOf({ engineKind: 'ninfer-native', argv }).speculative).toBeUndefined();
    // --spec without a value says nothing: only the draft count is left.
    expect(configParamsOf({ engineKind: 'ninfer-native', argv: ['/opt/ninfer-serve', '/m/a.ninfer', '--spec', '--draft-tokens', '4'] }).speculative).toBe('{"num_speculative_tokens":4}');
    // A vLLM-style legacy speculative setting is not mixed with NInfer's.
    expect(configParamsOf({ engineKind: 'ninfer-native', argv: ['/opt/ninfer-serve', '/m/a.ninfer', '--spec', 'dflash', '--draft-tokens', '7'] }).speculative).toBe('{"method":"dflash","num_speculative_tokens":7}');
  });
});
