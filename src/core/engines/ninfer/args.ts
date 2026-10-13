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
 * NInfer refuses the context-cache capacity flags together with --no-prefix-reuse: without prefix
 * reuse they are left out (and the plan says so).
 */
import type { LaunchParams, NinferParams, NinferSpec } from '../../../contract/engines';

/** Draft tokens when the settings name a speculative backend without a count (NInfer README: MTP 3, DFlash 7). */
export const DEFAULT_DRAFT_TOKENS: Record<Exclude<NinferSpec, 'off'>, number> = { mtp: 3, dflash: 7, dflash2: 7 };
/** --max-concurrency range. */
export const NINFER_MAX_CONCURRENCY = 8;

export interface NinferArgsOptions {
  /** The artifact as the engine opens it (a Linux path). */
  model: string;
  host: string;
  port: number;
  /** --model-id: the name requests must use (the ownership marker for benchmarks, the API name for servers). */
  modelId: string;
}

/** Context-cache flags that cannot go with --no-prefix-reuse, when the settings give them. */
export function droppedCacheFlags(n: NinferParams): string[] {
  if (n.prefixReuse !== false) return [];
  return [
    ...(n.deviceStateSlots !== undefined ? ['--device-state-slots'] : []),
    ...(n.hostStateSlots !== undefined ? ['--host-state-slots'] : []),
    ...(n.hostKvMib !== undefined ? ['--host-kv-mib'] : []),
  ];
}

/** ninfer-serve's arguments (the program not included). */
export function ninferServeArgs(params: LaunchParams, o: NinferArgsOptions): string[] {
  const n = params.ninfer ?? {};
  const args = [o.model, '--host', o.host, '--port', String(o.port), '--model-id', o.modelId];
  if (params.contextSize !== undefined) args.push('--max-context', String(params.contextSize));
  if (n.kvCapacity !== undefined) args.push('--kv-capacity', String(n.kvCapacity));
  if (params.parallel !== undefined) args.push('--max-concurrency', String(Math.min(NINFER_MAX_CONCURRENCY, params.parallel)));
  if (n.kvDtype !== undefined) args.push('--kv-dtype', n.kvDtype);
  const spec = n.spec ?? 'off';
  if (spec !== 'off') {
    args.push('--spec', spec, '--draft-tokens', String(n.draftTokens ?? DEFAULT_DRAFT_TOKENS[spec]));
    if (n.lmHeadDraft === true) args.push('--lm-head-draft');
  }
  if (n.vision === true) args.push('--vision');
  if (n.prefixReuse === false) args.push('--no-prefix-reuse');
  else {
    if (n.deviceStateSlots !== undefined) args.push('--device-state-slots', String(n.deviceStateSlots));
    if (n.hostStateSlots !== undefined) args.push('--host-state-slots', String(n.hostStateSlots));
    if (n.hostKvMib !== undefined) args.push('--host-kv-mib', String(n.hostKvMib));
  }
  if (n.thinking === false) args.push('--no-thinking');
  if (n.preserveThinking === true) args.push('--preserve-thinking');
  args.push(...params.extraArgs);
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
