/**
 * llama-server arguments, the same for the native and the Docker adapter: everything GPU Bench sets
 * is explicit (the record is exact), through a FlagGate so a build that lacks one of the flags (a
 * fork) runs without it and says so.
 */
import type { LaunchParams, RopeScaling } from '../../../contract/engines';
import { llamaFlashAttention, llamaKvLayoutArgs, llamaKvType } from '../shared/kv-flags';
import type { FlagGate } from '../shared/standard-flags';
import { aliasArg, type LlamaCaps } from './caps';

export const DEFAULT_CONTEXT = 4096;

export interface LlamaArgsOptions {
  modelPath: string;
  host: string;
  port: number;
  marker: string;
  apiName?: string | undefined;
}

/** `--rope-scaling yarn|linear --rope-scale <factor>` (+ `--yarn-orig-ctx <n>` for YaRN). */
export function llamaRopeArgs(r: RopeScaling | undefined, gate: FlagGate, args: string[]): void {
  if (!r) return;
  gate.push(args, '--rope-scaling', r.type);
  gate.push(args, '--rope-scale', String(r.factor));
  if (r.type === 'yarn') gate.push(args, '--yarn-orig-ctx', String(r.originalContext));
}

export function llamaArgs(params: LaunchParams, caps: LlamaCaps, o: LlamaArgsOptions, gate: FlagGate): string[] {
  const args: string[] = [];
  gate.push(args, '-m', o.modelPath);
  gate.push(args, '--host', o.host);
  gate.push(args, '--port', String(o.port));
  gate.push(args, '--alias', aliasArg(caps, o.marker, o.apiName));
  gate.push(args, '-c', String(params.contextSize ?? DEFAULT_CONTEXT));
  gate.push(args, '-ngl', params.gpuLayers !== undefined ? String(params.gpuLayers) : caps.nglKeywords.includes('all') ? 'all' : '999');
  const fa = llamaFlashAttention(params);
  if (caps.flashAttn === 'value') args.push('-fa', fa);
  else if (caps.flashAttn === 'toggle') {
    if (fa === 'on') args.push('-fa');
  } else gate.note('-fa');
  const kv = llamaKvType(params);
  if (kv !== undefined) {
    gate.push(args, '-ctk', kv);
    gate.push(args, '-ctv', kv);
  }
  if (params.batchSize !== undefined) gate.push(args, '-b', String(params.batchSize));
  if (params.ubatchSize !== undefined) gate.push(args, '-ub', String(params.ubatchSize));
  if (params.threads !== undefined) gate.push(args, '-t', String(params.threads));
  if (params.parallel !== undefined) gate.push(args, '-np', String(params.parallel));
  // One KV pool shared by all slots: a single long prompt can use the whole context, and the
  // behaviour no longer depends on the build's default.
  args.push(...llamaKvLayoutArgs(params, caps.flags));
  llamaRopeArgs(params.ropeScaling, gate, args);
  // Auto-fit would silently change ctx/ngl to fit memory: the measured config must be the requested one.
  if (caps.fitFlag) args.push('--fit', 'off');
  if (caps.flags.has('--no-webui')) args.push('--no-webui');
  args.push(...params.extraArgs);
  return args;
}
