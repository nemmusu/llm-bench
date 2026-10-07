import { describe, expect, it } from 'vitest';
import { scenarioLines } from '../../../../src/renderer/components/bench/summary';
import { createFormatters } from '../../../../src/renderer/i18n';

const it_ = createFormatters('it');
const en = createFormatters('en');

describe('scenarioLines: context sweep and long conversations', () => {
  it('describes the steps in plain words', () => {
    const steps = [
      { kind: 'context-sweep' as const, depths: [], fractions: false, outputTokens: 128, reps: 2 },
      { kind: 'sessions' as const, depth: 40960, levels: [1, 2], turns: 4, followupTokens: 256, outputTokens: 256 },
      { kind: 'sessions' as const, depth: 0, levels: [1], turns: 3, followupTokens: 256, outputTokens: 256 },
    ];
    expect(scenarioLines({ profile: 'custom', seed: 1, steps }, it_)).toEqual([
      'velocità con il contesto sempre più pieno',
      'conversazioni lunghe da 40.960 token: 1 e 2 alla volta, 4 messaggi ciascuna',
      'conversazioni lunghe con tutto il contesto disponibile: 1 alla volta, 3 messaggi ciascuna',
    ]);
    expect(scenarioLines({ profile: 'tune', seed: 1, steps: [steps[0]!] }, en)).toEqual(['speed as the context fills up']);
  });
});
