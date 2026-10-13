/**
 * ninfer-serve's command line from GPU Bench's launch settings (docs/serving.md "Server options"):
 *
 *   ninfer-serve <model.ninfer> --host H --port N --model-id ID
 *     --max-context  ← LaunchParams.contextSize      --max-concurrency ← parallel
 *     --kv-capacity  ← ninfer.kvCapacity (n | auto)  --kv-dtype ← ninfer.kvDtype
 *     --spec S --draft-tokens N [--lm-head-draft]    --vision
 *     --no-prefix-reuse | --device-state-slots N --host-state-slots N --host-kv-mib N
 *     --no-thinking  --preserve-thinking            …then the extra arguments.
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
}

/** ninfer-serve's arguments (the program not included). */
export function ninferServeArgs(params: LaunchParams, o: NinferArgsOptions): string[] {
  const args = [o.model, '--host', o.host, '--port', String(o.port), '--model-id', o.modelId];
  if (params.contextSize !== undefined) args.push('--max-context', String(params.contextSize));
  if (params.parallel !== undefined) args.push('--max-concurrency', String(Math.min(NINFER_MAX_CONCURRENCY, params.parallel)));
  args.push(...ninferFlags(params.ninfer), ...params.extraArgs);
  return args;
}

/**
 * The settings of a benchmark launch: every prompt read in full (--no-prefix-reuse) unless the
 * scenario measures long conversations, which is what prefix reuse is for; no thinking (the answer
 * starts at once, as with the other engines); the user's explicit choices win.
 */
export function ninferBenchParams(n: NinferParams | undefined, o: { conversations: boolean }): NinferParams {
  return { ...n, prefixReuse: n?.prefixReuse ?? o.conversations, thinking: n?.thinking ?? false };
}
