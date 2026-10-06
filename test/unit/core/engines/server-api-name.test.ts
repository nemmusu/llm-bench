import { describe, expect, it } from 'vitest';
import type { ModelIdentity } from '../../../../src/contract/models';
import { serverApiName, type ModelTarget } from '../../../../src/core/engines/types';

const target = (identity: Partial<ModelIdentity>, repo?: string): ModelTarget => ({
  identity: { displayName: 'Qwen3-4B-Q4_K_M', format: 'gguf', source: 'local', files: [], weakKey: 'k', ...identity },
  ...(repo ? { repo } : {}),
});

describe('the model name a server shows to other programs', () => {
  it('vLLM: the HF repo id (as clients expect), else the model name', () => {
    expect(serverApiName('vllm-docker', target({}, 'Qwen/Qwen3-0.6B'))).toBe('Qwen/Qwen3-0.6B');
    expect(serverApiName('vllm-native', target({ repo: 'org/model' }))).toBe('org/model');
    expect(serverApiName('vllm-docker', target({ displayName: 'local st' }))).toBe('local-st');
  });

  it('llama.cpp: the model name, without commas or spaces (llama.cpp splits aliases at commas)', () => {
    expect(serverApiName('llamacpp-native', target({ repo: 'Qwen/Qwen3-4B-GGUF' }, 'x/y'))).toBe('Qwen3-4B-Q4_K_M');
    expect(serverApiName('llamacpp-docker', target({ displayName: 'My model, v2  final' }))).toBe('My-model-v2-final');
  });
});
