import { describe, expect, it } from 'vitest';
import { RUN_APP_NAMES, runAppLabel, runAppSchema } from '../../../src/contract/results';

describe('the app that saved a run (renamed GPU Bench → LLM Bench in 0.4.0)', () => {
  it('old runs keep their name (history), new ones say LLM Bench', () => {
    expect(runAppLabel({ name: 'gpu-bench', version: '0.3.0' })).toBe('GPU Bench 0.3.0');
    expect(runAppLabel({ name: 'llm-bench', version: '0.4.0' })).toBe('LLM Bench 0.4.0');
    expect(RUN_APP_NAMES['llm-bench']).toBe('LLM Bench');
  });

  it('a run file names one of the two', () => {
    expect(runAppSchema.safeParse({ name: 'gpu-bench', version: '0.1.0' }).success).toBe(true);
    expect(runAppSchema.safeParse({ name: 'llm-bench', version: '0.4.0' }).success).toBe(true);
    expect(runAppSchema.safeParse({ name: 'other-bench', version: '1.0.0' }).success).toBe(false);
  });
});
