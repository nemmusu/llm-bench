/**
 * Reasoning and vision, the same choice for every engine (core/engines/shared/reasoning-vision.ts):
 * each engine says it with the option its --help lists, else its default applies and the launch says so.
 */
import { describe, expect, it } from 'vitest';
import { launchParamsSchema } from '../../../../src/contract/engines';
import { llamaArgs } from '../../../../src/core/engines/llamacpp-native/args';
import { currentLlamaCaps } from '../../../../src/core/engines/llamacpp-native/caps';
import {
  chatKwargsOf,
  llamaReasoningArgs,
  multimodalArchitecture,
  projectorOf,
  sglangReasoningVision,
  vllmReasoningVisionArgs,
  withLlamaVision,
} from '../../../../src/core/engines/shared/reasoning-vision';
import { sglangServeArgs } from '../../../../src/core/engines/shared/sglang';
import { FlagGate } from '../../../../src/core/engines/shared/standard-flags';
import { vllmServeArgs } from '../../../../src/core/engines/shared/vllm-args';

const P = (over: object = {}) => launchParamsSchema.parse(over);
const gate = (base: 'llamacpp' | 'vllm' | 'sglang', flags?: string[]) => new FlagGate(base, flags ? new Set(flags) : undefined);
const model = (aux: { kind: 'mmproj' | 'mtp' | 'draft' | 'other'; path: string }[] = []) => ({ local: { auxiliary: aux } }) as never;

describe('llama.cpp', () => {
  it('reasoning off: --reasoning off, older builds --reasoning-budget 0, else the chat template kwargs, else said', () => {
    expect(llamaReasoningArgs(P(), gate('llamacpp'))).toEqual([]);
    expect(llamaReasoningArgs(P({ reasoning: true }), gate('llamacpp'))).toEqual([]);
    expect(llamaReasoningArgs(P({ reasoning: false }), gate('llamacpp'))).toEqual(['--reasoning', 'off']);
    expect(llamaReasoningArgs(P({ reasoning: false }), gate('llamacpp', ['--reasoning-budget']))).toEqual(['--reasoning-budget', '0']);
    expect(llamaReasoningArgs(P({ reasoning: false }), gate('llamacpp', ['--chat-template-kwargs']))).toEqual(['--chat-template-kwargs', '{"enable_thinking":false}']);
    const old = gate('llamacpp', ['-m', '--host', '--port', '--alias']);
    expect(llamaReasoningArgs(P({ reasoning: false }), old)).toEqual([]);
    expect(old.missing).toEqual([{ flag: '--reasoning', setting: 'reasoning', effect: 'default' }]);
    // In the whole command, with LLM Bench's own settings, before the extra arguments.
    const args = llamaArgs(P({ reasoning: false, extraArgs: ['--metrics'] }), currentLlamaCaps(), { modelPath: 'm.gguf', host: 'h', port: 1, marker: 'gpubench-x' }, gate('llamacpp'));
    expect(args.slice(-6)).toEqual(['--reasoning', 'off', '--fit', 'off', '--no-webui', '--metrics']);
  });

  it('vision: the projector grouped with the model unless switched off, already named, or the build cannot load one', () => {
    const withProjector = model([{ kind: 'mtp', path: '/m/mtp.gguf' }, { kind: 'mmproj', path: '/m/mmproj.gguf' }]);
    expect(projectorOf(withProjector)).toBe('/m/mmproj.gguf');
    expect(projectorOf({ local: undefined } as never)).toBeUndefined();
    expect(withLlamaVision(P({ extraArgs: ['-x'] }), withProjector, gate('llamacpp')).extraArgs).toEqual(['--mmproj', '/m/mmproj.gguf', '-x']);
    expect(withLlamaVision(P({ vision: false }), withProjector, gate('llamacpp')).extraArgs).toEqual([]);
    expect(withLlamaVision(P(), model(), gate('llamacpp')).extraArgs).toEqual([]);
    expect(withLlamaVision(P({ extraArgs: ['--mmproj=/other.gguf'] }), withProjector, gate('llamacpp')).extraArgs).toEqual(['--mmproj=/other.gguf']);
    // A build without --mmproj: on only where it can; said when it was asked for.
    const quiet = gate('llamacpp', ['-m', '--host', '--port', '--alias']);
    expect(withLlamaVision(P(), withProjector, quiet).extraArgs).toEqual([]);
    expect(quiet.missing).toEqual([]);
    const asked = gate('llamacpp', ['-m', '--host', '--port', '--alias']);
    expect(withLlamaVision(P({ vision: true }), withProjector, asked).extraArgs).toEqual([]);
    expect(asked.missing).toEqual([{ flag: '--mmproj', setting: 'vision', effect: 'default' }]);
  });
});

describe('vLLM and SGLang', () => {
  it('vLLM: the default chat template kwargs; vision off only for a model that reads images', () => {
    expect(vllmReasoningVisionArgs(P(), true, gate('vllm'))).toEqual([]);
    expect(vllmReasoningVisionArgs(P({ reasoning: false, vision: false }), true, gate('vllm'))).toEqual([
      '--default-chat-template-kwargs',
      '{"enable_thinking":false}',
      '--limit-mm-per-prompt',
      '{"image":0,"video":0}',
    ]);
    expect(vllmReasoningVisionArgs(P({ vision: false }), false, gate('vllm'))).toEqual([]);
    const old = gate('vllm', ['--host', '--port', '--served-model-name']);
    expect(vllmReasoningVisionArgs(P({ reasoning: false, vision: false }), true, old)).toEqual([]);
    expect(old.missing.map((m) => [m.flag, m.setting])).toEqual([
      ['--default-chat-template-kwargs', 'reasoning'],
      ['--limit-mm-per-prompt', 'vision'],
    ]);
    expect(['Qwen2_5_VLForConditionalGeneration', 'Gemma3ForConditionalGeneration', 'LlavaForCausalLM'].every(multimodalArchitecture)).toBe(true);
    expect([undefined, 'Qwen3ForCausalLM', 'LlamaForCausalLM'].some(multimodalArchitecture)).toBe(false);
    const serve = vllmServeArgs(P({ reasoning: false, extraArgs: ['--x'] }), { model: 'm', positional: true, host: 'h', port: 1, servedName: 's', multimodal: false });
    expect(serve.slice(-3)).toEqual(['--default-chat-template-kwargs', '{"enable_thinking":false}', '--x']);
  });

  it('SGLang: no server option for reasoning off, said always; vision keeps its default', () => {
    const g = gate('sglang');
    sglangReasoningVision(P({ reasoning: true }), g);
    expect(g.missing).toEqual([]);
    sglangReasoningVision(P({ reasoning: false }), g);
    expect(g.missing).toEqual([{ flag: '--reasoning', setting: 'reasoning', effect: 'default' }]);
    const g2 = gate('sglang');
    const args = sglangServeArgs(P({ reasoning: false, vision: false }), { model: 'm', host: 'h', port: 1, servedName: 's' }, g2);
    expect(args).not.toContain('--reasoning');
    expect(g2.missing.map((m) => m.setting)).toEqual(['reasoning']);
  });
});

describe('chat requests of an external or command engine', () => {
  it('ask the template not to think only when reasoning is off and the requests are chat', () => {
    expect(chatKwargsOf('openai-chat', P({ reasoning: false }))).toEqual({ chatTemplateKwargs: { enable_thinking: false } });
    expect(chatKwargsOf('openai-chat', P())).toEqual({});
    expect(chatKwargsOf('openai', P({ reasoning: false }))).toEqual({});
    expect(chatKwargsOf('openai-chat', undefined)).toEqual({});
  });
});
