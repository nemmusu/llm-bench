/**
 * ninfer-serve's command line from LLM Bench's launch settings (docs/serving.md "Server options"):
 *
 *   ninfer-serve <model.ninfer> --host H --port N --model-id ID
 *     --max-context  ← LaunchParams.contextSize      --max-concurrency ← parallel
 *     --kv-capacity  ← ninfer.kvCapacity (n | auto)  --kv-dtype ← ninfer.kvDtype
 *     --spec S --draft-tokens N [--lm-head-draft]    --vision
 *     --no-prefix-reuse | --device-state-slots N --host-state-slots N --host-kv-mib N
 *     --no-thinking  --preserve-thinking            …then the extra arguments.
 *   (--vision and --no-thinking also from LaunchParams.vision / reasoning, see ninferWithReasoningVision.)
 *
 * NInfer's own settings are contract/ninfer.ts ninferFlags (the configuration labels read the same list).
 */
import type { LaunchParams, NinferParams } from '../../../contract/engines';
import { NINFER_MAX_CONCURRENCY, ninferFlags } from '../../../contract/ninfer';

export interface NinferArgsOptions {
  /** The artifact as the engine opens it (a Linux path). */
  model: string;
  host: string;
  port: number;
  /** --model-id: the name requests must use (the ownership marker for benchmarks, the API name for servers). */
  modelId: string;
  /** The artifact packs vision (its manifest's components): --vision unless switched off. */
  hasVision?: boolean;
}

/**
 * NInfer's own settings with the launch's reasoning and vision (LaunchParams.reasoning / vision,
 * shared by every engine): reasoning off = --no-thinking; vision on where the artifact packs it.
 * A choice said in NInfer's own settings (ninfer.thinking / vision, older saved runs) holds when the
 * shared one is not set.
 */
export function ninferWithReasoningVision(params: Pick<LaunchParams, 'ninfer' | 'reasoning' | 'vision'>, hasVision: boolean): NinferParams | undefined {
  const n = params.ninfer;
  const thinking = params.reasoning ?? n?.thinking;
  const vision = params.vision === false ? false : (n?.vision ?? (hasVision || undefined));
  if (thinking === n?.thinking && vision === n?.vision) return n;
  return { ...n, ...(thinking !== undefined ? { thinking } : {}), ...(vision !== undefined ? { vision } : {}) };
}

/** ninfer-serve's arguments (the program not included). */
export function ninferServeArgs(params: LaunchParams, o: NinferArgsOptions): string[] {
  const args = [o.model, '--host', o.host, '--port', String(o.port), '--model-id', o.modelId];
  if (params.contextSize !== undefined) args.push('--max-context', String(params.contextSize));
  if (params.parallel !== undefined) args.push('--max-concurrency', String(Math.min(NINFER_MAX_CONCURRENCY, params.parallel)));
  args.push(...ninferFlags(ninferWithReasoningVision(params, o.hasVision === true)), ...params.extraArgs);
  return args;
}

/**
 * The settings of a benchmark launch: every prompt read in full (--no-prefix-reuse) unless the
 * scenario measures long conversations, which is what prefix reuse is for; reasoning as the launch
 * says (LaunchParams.reasoning: on unless switched off); the user's explicit choices win.
 */
export function ninferBenchParams(n: NinferParams | undefined, o: { conversations: boolean }): NinferParams {
  return { ...n, prefixReuse: n?.prefixReuse ?? o.conversations };
}
