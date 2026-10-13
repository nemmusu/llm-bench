import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { capacityHintOf, parseKvCapacity } from '../../../../../src/core/engines/shared/kv-capacity';
import { parseLoadProgress } from '../../../../../src/core/engines/shared/load-progress';
import { NINFER_FIXTURES } from './helpers';

const SERVE = readFileSync(path.join(NINFER_FIXTURES, 'serve-nvfp4-int8.log'), 'utf8').split(/\r?\n/);

describe('NInfer in the shared start parsers', () => {
  it('reads its KV pool; the tuner gets a hint only from --kv-capacity auto', () => {
    expect(parseKvCapacity(SERVE, 'ninfer-wsl')).toEqual({ tokens: 131_072 });
    expect(capacityHintOf(SERVE, 'ninfer-wsl')).toBeUndefined();
    expect(capacityHintOf(['2026-09-28 12:33:02.716  INFO  capacity | KV 196,608 tokens, int8, auto | pages 3,072/3,072'], 'ninfer-native')).toBe(196_608);
  });

  it('follows its start', () => {
    expect(parseLoadProgress('2026-09-28 12:32:55.990  INFO  weights ready | 20.0 GiB | 2.8s | 7.25 GiB/s', 'ninfer-native')).toMatchObject({ stage: 'weights', fraction: 1 });
  });
});
