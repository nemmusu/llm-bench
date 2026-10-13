/**
 * The flags LLM Bench itself passes to each engine, and what to do when a build does not know one.
 *
 * Forks keep their base's flags, at most with extras; some lack a few (an older base, a trimmed
 * fork). A flag the build's --help does not list is left out of the command (the engine's own
 * default then applies) and reported (LaunchPlan.unsupported → the run's 'flag_unsupported' note,
 * the Engines page check). Without the flags LLM Bench cannot do without (model, host, port, the
 * served name its readiness checks look for) the engine cannot be used: ENGINE_BAD_FLAG.
 *
 * A --help that does not list every required flag is not trusted (a help printed in another format):
 * nothing is left out then, as before.
 */
import type { MissingFlag } from '../../../contract/custom-engines';
import type { EngineBase } from '../../../contract/engines';
import { AppError } from '../../../contract/errors';

export interface StandardFlag {
  /** Every spelling; the first is the one LLM Bench writes. */
  spellings: readonly string[];
  /** LaunchParams key (or 'alias', 'seed', 'cacheReport'…) the flag carries. */
  setting: string;
  required?: boolean;
}

export type FlagBase = Exclude<EngineBase, 'external'>;

export const STANDARD_FLAGS: Record<FlagBase, readonly StandardFlag[]> = {
  llamacpp: [
    { spellings: ['-m', '--model'], setting: 'model', required: true },
    { spellings: ['--host'], setting: 'host', required: true },
    { spellings: ['--port'], setting: 'port', required: true },
    // Readiness checks look for the marker among the model's names.
    { spellings: ['--alias', '-a'], setting: 'alias', required: true },
    { spellings: ['-c', '--ctx-size'], setting: 'contextSize' },
    { spellings: ['-ngl', '--gpu-layers', '--n-gpu-layers'], setting: 'gpuLayers' },
    { spellings: ['-fa', '--flash-attn'], setting: 'flashAttention' },
    { spellings: ['-ctk', '--cache-type-k'], setting: 'kvCacheType' },
    { spellings: ['-ctv', '--cache-type-v'], setting: 'kvCacheType' },
    { spellings: ['-b', '--batch-size'], setting: 'batchSize' },
    { spellings: ['-ub', '--ubatch-size'], setting: 'ubatchSize' },
    { spellings: ['-t', '--threads'], setting: 'threads' },
    { spellings: ['-np', '--parallel'], setting: 'parallel' },
    { spellings: ['--rope-scaling'], setting: 'ropeScaling' },
    { spellings: ['--rope-scale'], setting: 'ropeScaling' },
    { spellings: ['--yarn-orig-ctx'], setting: 'ropeScaling' },
  ],
  vllm: [
    { spellings: ['--host'], setting: 'host', required: true },
    { spellings: ['--port'], setting: 'port', required: true },
    { spellings: ['--served-model-name'], setting: 'alias', required: true },
    { spellings: ['--max-model-len'], setting: 'contextSize' },
    { spellings: ['--gpu-memory-utilization'], setting: 'gpuMemoryUtilization' },
    { spellings: ['--max-num-seqs'], setting: 'parallel' },
    { spellings: ['--kv-cache-dtype'], setting: 'kvCacheType' },
    { spellings: ['--max-num-batched-tokens'], setting: 'batchSize' },
    { spellings: ['--seed'], setting: 'seed' },
    { spellings: ['--dtype'], setting: 'dtype' },
    { spellings: ['--quantization', '-q'], setting: 'quantization' },
    { spellings: ['--hf-overrides', '--rope-scaling'], setting: 'ropeScaling' },
  ],
  sglang: [
    { spellings: ['--model-path', '--model'], setting: 'model', required: true },
    { spellings: ['--host'], setting: 'host', required: true },
    { spellings: ['--port'], setting: 'port', required: true },
    { spellings: ['--served-model-name'], setting: 'alias', required: true },
    { spellings: ['--context-length'], setting: 'contextSize' },
    { spellings: ['--mem-fraction-static'], setting: 'gpuMemoryUtilization' },
    { spellings: ['--max-running-requests'], setting: 'parallel' },
    { spellings: ['--kv-cache-dtype'], setting: 'kvCacheType' },
    { spellings: ['--chunked-prefill-size'], setting: 'batchSize' },
    { spellings: ['--random-seed'], setting: 'seed' },
    { spellings: ['--enable-cache-report'], setting: 'cacheReport' },
    { spellings: ['--dtype'], setting: 'dtype' },
    { spellings: ['--quantization'], setting: 'quantization' },
    { spellings: ['--json-model-override-args'], setting: 'ropeScaling' },
  ],
  // ninfer-serve <model.ninfer> [options] (the model is positional); docs/serving.md "Server options".
  ninfer: [
    { spellings: ['--host'], setting: 'host', required: true },
    { spellings: ['--port'], setting: 'port', required: true },
    { spellings: ['--model-id'], setting: 'alias', required: true },
    { spellings: ['--max-context'], setting: 'contextSize' },
    { spellings: ['--max-concurrency'], setting: 'parallel' },
    { spellings: ['--kv-capacity'], setting: 'ninfer.kvCapacity' },
    { spellings: ['--kv-dtype'], setting: 'ninfer.kvDtype' },
    { spellings: ['--spec'], setting: 'ninfer.spec' },
    { spellings: ['--draft-tokens'], setting: 'ninfer.draftTokens' },
    { spellings: ['--lm-head-draft'], setting: 'ninfer.lmHeadDraft' },
    { spellings: ['--vision'], setting: 'ninfer.vision' },
    { spellings: ['--no-prefix-reuse'], setting: 'ninfer.prefixReuse' },
    { spellings: ['--no-thinking'], setting: 'ninfer.thinking' },
  ],
};

const specOf = (base: FlagBase, flag: string): StandardFlag | undefined => STANDARD_FLAGS[base].find((s) => s.spellings.includes(flag));
const knows = (known: ReadonlySet<string>, spec: StandardFlag): boolean => spec.spellings.some((s) => known.has(s));

/** The options of a --help, when they can be trusted: every required flag is listed. undefined = unknown. */
export function trustedFlags(base: FlagBase, known: ReadonlySet<string> | undefined): ReadonlySet<string> | undefined {
  if (!known || known.size === 0) return undefined;
  return STANDARD_FLAGS[base].every((s) => !s.required || knows(known, s)) ? known : undefined;
}

/**
 * The standard flags a build lacks (the Engines page check). An untrusted help gives none, except
 * when it lists options but none of the required ones: then they are what is missing.
 */
export function missingStandardFlags(base: FlagBase, known: ReadonlySet<string>): MissingFlag[] {
  const out: MissingFlag[] = [];
  const seen = new Set<string>();
  for (const s of STANDARD_FLAGS[base]) {
    const flag = s.spellings[0] as string;
    if (knows(known, s) || seen.has(flag)) continue;
    seen.add(flag);
    out.push({ flag, setting: s.setting, effect: s.required ? 'required' : 'default' });
  }
  return out;
}

/**
 * Builds LLM Bench's own part of a command for a build whose options are `known` (undefined = not
 * known: everything is passed). A flag the build lacks is left out and remembered in `missing`;
 * a required one stops the launch.
 */
export class FlagGate {
  readonly missing: MissingFlag[] = [];

  constructor(
    private readonly base: FlagBase,
    private readonly known: ReadonlySet<string> | undefined,
  ) {}

  /** The build knows `flag` (any of its spellings), or its options are not known. */
  has(flag: string): boolean {
    if (!this.known) return true;
    const spec = specOf(this.base, flag);
    return spec ? knows(this.known, spec) : this.known.has(flag);
  }

  /** This exact spelling is listed (or the options are not known): picks between two flags for one setting. */
  lists(flag: string): boolean {
    return !this.known || this.known.has(flag);
  }

  /** Appends `flag values…` to `args` when the build knows it; otherwise records (or refuses) it. */
  push(args: string[], flag: string, ...values: string[]): void {
    if (this.has(flag)) {
      args.push(flag, ...values);
      return;
    }
    const spec = specOf(this.base, flag);
    if (spec?.required) {
      throw new AppError('ENGINE_BAD_FLAG', `The engine does not accept ${flag}`, { params: { flag, reason: 'required_flag_missing' } });
    }
    this.record(flag, spec);
  }

  /** The build has no `flag` at all (seen in its caps): recorded when its options are known, nothing otherwise. */
  note(flag: string): void {
    if (this.known && !this.has(flag)) this.record(flag, specOf(this.base, flag));
  }

  private record(flag: string, spec: StandardFlag | undefined): void {
    if (!this.missing.some((m) => m.flag === flag)) this.missing.push({ flag, setting: spec?.setting ?? flag, effect: 'default' });
  }
}
