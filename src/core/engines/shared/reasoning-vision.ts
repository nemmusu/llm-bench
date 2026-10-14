/**
 * Reasoning ("thinking") and image input, the same choice for every engine (LaunchParams.reasoning /
 * vision): absent or true = on when the model supports it, false = off. Each engine says it its own
 * way, and only with an option its --help lists; when it has none, its own default applies and the
 * launch says so (FlagGate → the plan's 'flag_unsupported').
 *
 *   llama.cpp   reasoning off: --reasoning off, older builds --reasoning-budget 0, else
 *               --chat-template-kwargs {"enable_thinking":false}; vision: --mmproj <the projector the
 *               library groups with the model> unless switched off (or a projector is already named).
 *   vLLM        reasoning off: --default-chat-template-kwargs {"enable_thinking":false}; vision off
 *               (a multimodal model): --limit-mm-per-prompt {"image":0,"video":0}.
 *   SGLang      no server option for either: its default (reasoning off is said, a chat request can ask).
 *   TensorRT-LLM the same: trtllm-serve has no option for either (a chat request can ask with
 *               chat_template_kwargs); reasoning or image input switched off is said in the plan.
 *   NInfer      reasoning: --no-thinking when off; vision: --vision when the artifact packs it.
 *   external,   their chat requests carry chat_template_kwargs {"enable_thinking":false} when reasoning
 *   command     is off (and nothing otherwise: strict servers reject unknown fields).
 *
 * Benchmarks that send raw prompts (llama.cpp /completion, vLLM and SGLang /v1/completions) apply no
 * chat template: reasoning changes nothing they measure; a server ("Avvia solo il server") keeps it.
 */
import type { ApiFlavor, LaunchParams } from '../../../contract/engines';
import type { ModelTarget } from '../types';
import type { FlagGate } from './standard-flags';

/** What a chat request sends to switch reasoning off (the Qwen3 / DeepSeek / GLM templates read it). */
export const THINKING_OFF_KWARGS = { enable_thinking: false } as const;
const THINKING_OFF = JSON.stringify(THINKING_OFF_KWARGS);

/** llama-server: reasoning switched off, in the first way the build knows. */
export function llamaReasoningArgs(params: Pick<LaunchParams, 'reasoning'>, gate: FlagGate): string[] {
  if (params.reasoning !== false) return [];
  if (gate.lists('--reasoning')) return ['--reasoning', 'off'];
  if (gate.lists('--reasoning-budget')) return ['--reasoning-budget', '0'];
  if (gate.lists('--chat-template-kwargs')) return ['--chat-template-kwargs', THINKING_OFF];
  gate.unsupported('--reasoning', 'reasoning');
  return [];
}

/** Options that already name an image projector (a recipe's, the user's). */
const MMPROJ = ['-mm', '--mmproj', '--mmproj-url', '-mmu'];

/** The image projector the library groups with the model (llama.cpp), when it has one. */
export function projectorOf(model: Pick<ModelTarget, 'local'>): string | undefined {
  return model.local?.auxiliary.find((a) => a.kind === 'mmproj')?.path;
}

/**
 * llama-server: the launch with the model's image projector among its extra arguments (so the Docker
 * adapter sees it as a host path to mount) unless vision is switched off, the model has none, the
 * build cannot load one, or the arguments already name one.
 */
export function withLlamaVision(params: LaunchParams, model: Pick<ModelTarget, 'local'>, gate: FlagGate): LaunchParams {
  const projector = projectorOf(model);
  if (params.vision === false || projector === undefined) return params;
  if (params.extraArgs.some((a) => MMPROJ.includes(a.split('=')[0] as string))) return params;
  if (!gate.lists('--mmproj')) {
    // Asked for in so many words: said; left to LLM Bench: on only where the build can.
    if (params.vision === true) gate.unsupported('--mmproj', 'vision');
    return params;
  }
  return { ...params, extraArgs: ['--mmproj', projector, ...params.extraArgs] };
}

/** A model that reads images, from its architecture (config.json "architectures"): Qwen2.5-VL, Gemma 3, LLaVA, Mistral 3… */
export function multimodalArchitecture(architecture: string | undefined): boolean {
  return architecture !== undefined && /VL|Vision|Llava|ForConditionalGeneration/i.test(architecture);
}

/** vLLM: reasoning off and vision off (a multimodal model only: vLLM refuses the limit for a text model). */
export function vllmReasoningVisionArgs(params: Pick<LaunchParams, 'reasoning' | 'vision'>, multimodal: boolean, gate: FlagGate): string[] {
  const args: string[] = [];
  if (params.reasoning === false) {
    if (gate.lists('--default-chat-template-kwargs')) args.push('--default-chat-template-kwargs', THINKING_OFF);
    else gate.unsupported('--default-chat-template-kwargs', 'reasoning');
  }
  if (params.vision === false && multimodal) {
    if (gate.lists('--limit-mm-per-prompt')) args.push('--limit-mm-per-prompt', JSON.stringify({ image: 0, video: 0 }));
    else gate.unsupported('--limit-mm-per-prompt', 'vision');
  }
  return args;
}

/** SGLang: no server option switches reasoning off; said when it was asked (the engine's default applies). */
export function sglangReasoningVision(params: Pick<LaunchParams, 'reasoning'>, gate: FlagGate): void {
  if (params.reasoning === false) gate.unsupported('--reasoning', 'reasoning', true);
}

/**
 * TensorRT-LLM: trtllm-serve has no server option to switch reasoning or a multimodal model's image input
 * off; asked for, it is said (the engine's own behaviour applies). Its benchmarks send raw prompts
 * (/v1/completions): no chat template, so reasoning changes nothing they measure.
 */
export function trtllmReasoningVision(params: Pick<LaunchParams, 'reasoning' | 'vision'>, gate: FlagGate): void {
  if (params.reasoning === false) gate.unsupported('--reasoning', 'reasoning', true);
  if (params.vision === false) gate.unsupported('--vision', 'vision', true);
}

/**
 * Client options of an external or command engine: its chat requests ask the template not to think
 * when reasoning is switched off. Raw-prompt flavours apply no template: nothing to send there.
 */
export function chatKwargsOf(flavor: ApiFlavor, params: Pick<LaunchParams, 'reasoning'> | undefined): { chatTemplateKwargs?: Record<string, unknown> } {
  return flavor === 'openai-chat' && params?.reasoning === false ? { chatTemplateKwargs: { ...THINKING_OFF_KWARGS } } : {};
}
