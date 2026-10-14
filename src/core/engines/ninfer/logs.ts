/**
 * What ninfer-serve says on stderr (redirected: persistent readable lines, no terminal control
 * sequences), as seen on an RTX 5090 with Qwen3.8-27B:
 *
 *   2026-09-28 12:32:52.531  INFO  starting engine
 *   … INFO  loading weights | 20.0 GiB
 *   … INFO  weights ready | 20.0 GiB | 2.8s | 7.25 GiB/s
 *   … INFO  pinning host state | 1.15 GiB            … INFO  host KV pinned | 8.00 GiB | 3.7s
 *   … INFO  CUDA graphs ready | 2.3s
 *   … INFO  engine ready | qwen3.8-27b | total 10.2s | weights 20.0 GiB | CUDA sync spin
 *   … INFO  capacity | KV 131,072 tokens, int8, explicit | pages 2,048/2,048 | runtime 5.95 GiB | free 3.33 GiB
 *   … INFO  listening on http://127.0.0.1:18082 | model qwen3.8-27b | auth disabled
 *   … INFO  throughput | 5.0s | prefill 1.34k tok/s (6,698 tok) | decode 121.6 tok/s (608 tok) | running 1 …
 *   … INFO  req#9 done | openai-chat | stop token | prompt 26,752 | output 38 | cache 0 (0.0%) | TTFT 3.6s | …
 *   … FATAL server failed during startup | requested Engine runtime reservation requires 11099231489 bytes,
 *           but only 10948182016 bytes are available for runtime capacity
 *
 * Start-up failures (src/serve/operational_log.cpp: `server failed during {startup|serving} | <detail>`,
 * `warmup failed | <time> | <detail>`, `cannot bind <host>:<port>`; option errors as "ninfer-serve:
 * unknown argument: --x" / "invalid kv-dtype: x"). Seen on an RTX 5090 with a GGUF-converted artifact
 * and the official build:
 *
 *   2026-10-13 21:01:51.827  ERROR startup failed | planning runtime | 874 ms
 *   2026-10-13 21:01:51.829  FATAL server failed during startup | weight/000130: unknown tensor layout: gguf_blocks_v1
 *
 * The artifact reader's own (src/artifact): "unknown tensor layout: X", "unknown tensor format: X",
 * "<path>: NInfer v2 artifact is not supported. Upgrade to v3 with: python3 tools/upgrade_ninfer_v2_to_v3.py
 * INPUT.ninfer OUTPUT.ninfer", "<path>: expected NInfer v3 entry magic".
 */
import { templateForLayout } from '../../../contract/custom-engines';
import { AppError } from '../../../contract/errors';
import type { KvCapacity } from '../../../contract/results';
import type { ExitInfo } from '../../deps';
import { missingLibrary } from '../../process/missing-library';
import type { LoadProgress } from '../../../contract/events';

/** "2026-09-28 12:32:52.531  INFO  msg" → "msg" (lines without the prefix are kept as they are). */
export function ninferMessage(line: string): string {
  return line.replace(/^\s*\d{4}-\d\d-\d\d \d\d:\d\d:\d\d(?:\.\d+)?\s+[A-Z]+\s+/, '').trim();
}

const num = (s: string): number => Number(s.replace(/,/g, ''));
/** "1.34k" → 1340, "8.68k" → 8680. */
const rate = (s: string): number => (s.endsWith('k') ? Number(s.slice(0, -1)) * 1000 : Number(s));
const UNITS: Record<string, number> = { B: 1 / 1024 ** 2, KiB: 1 / 1024, MiB: 1, GiB: 1024 };
/** "5.95 GiB" → MiB. */
export function sizeMiB(text: string): number | undefined {
  const m = /([\d.]+)\s*(B|KiB|MiB|GiB)\b/.exec(text);
  return m ? Math.round(Number(m[1]) * (UNITS[m[2] as string] as number) * 100) / 100 : undefined;
}

/** What one log line says about the start (shared/load-progress.ts LoadUpdate; typed here so the two modules do not import each other). */
type LoadUpdate = Omit<LoadProgress, 'elapsedMs' | 'expectedMs'>;

/** What one stderr line says about the start (core/engines/shared/load-progress.ts for base 'ninfer'). */
export function ninferProgress(line: string): LoadUpdate | undefined {
  const msg = ninferMessage(line);
  const detail = msg.slice(0, 160);
  const head = msg.split(' | ')[0] as string;
  if (/^listening on /.test(head)) return { stage: 'api-server', detail };
  if (/^(engine ready|capacity|context cache|media)$/.test(head)) return { stage: 'warmup', ...(head === 'engine ready' ? { fraction: 1 } : {}), detail };
  if (head === 'CUDA graphs ready') return { stage: 'cuda-graphs', fraction: 1, detail };
  if (/^(capturing CUDA graphs|CUDA graphs)/i.test(head)) return { stage: 'cuda-graphs', detail };
  if (/^(pinning host (state|KV)|host (state|KV) pinned|allocating|reserving)/i.test(head)) return { stage: 'kv-cache', detail };
  if (head === 'weights ready') return { stage: 'weights', fraction: 1, detail };
  if (/^loading weights/.test(head)) {
    // Progress lines of a long load: "loading weights | 9.0/20.0 GiB" or "… | 45%".
    const of = /([\d.]+)\s*\/\s*([\d.]+)\s*GiB/.exec(msg);
    const pct = /(\d+(?:\.\d+)?)\s*%/.exec(msg);
    const fraction = of ? Number(of[1]) / Number(of[2]) : pct ? Number(pct[1]) / 100 : undefined;
    return { stage: 'weights', ...(fraction !== undefined && Number.isFinite(fraction) ? { fraction: Math.min(1, fraction) } : {}), detail };
  }
  if (head === 'starting engine') return { stage: 'starting', detail };
  return undefined;
}

/** "capacity | KV 131,072 tokens, int8, explicit | …": the KV pool's tokens. */
export function ninferKvCapacity(lines: readonly string[]): KvCapacity | undefined {
  let tokens: number | undefined;
  for (const l of lines) {
    const m = /\bcapacity \| KV ([\d,]+) tokens/.exec(l);
    if (m) tokens = num(m[1] as string);
  }
  return tokens !== undefined && tokens > 0 ? { tokens } : undefined;
}

/** NInfer's own account of its memory at start: weights, runtime (KV pool included) and what it left free, MiB. */
export interface NinferMemoryReport {
  weightsMiB?: number;
  runtimeMiB?: number;
  freeMiB?: number;
  kvTokens?: number;
  kvDtype?: string;
  /** 'explicit' (--kv-capacity N or --max-context) or 'auto'. */
  kvMode?: string;
}

export function ninferMemoryReport(lines: readonly string[]): NinferMemoryReport {
  const out: NinferMemoryReport = {};
  for (const l of lines) {
    const msg = ninferMessage(l);
    const ready = /^engine ready \|.*\| weights ([\d.]+ \w+)/.exec(msg);
    if (ready) out.weightsMiB = sizeMiB(ready[1] as string) as number;
    const cap = /^capacity \| KV ([\d,]+) tokens, (\w+), (\w+)(?:.*\| runtime ([\d.]+ \w+))?(?:.*\| free ([\d.]+ \w+))?/.exec(msg);
    if (cap) {
      out.kvTokens = num(cap[1] as string);
      out.kvDtype = cap[2] as string;
      out.kvMode = cap[3] as string;
      if (cap[4]) out.runtimeMiB = sizeMiB(cap[4]) as number;
      if (cap[5]) out.freeMiB = sizeMiB(cap[5]) as number;
    }
  }
  return out;
}

/** One periodic "throughput | 5.0s | prefill … | decode … | running …" line. */
export interface NinferThroughput {
  intervalSec: number;
  prefillTps?: number;
  decodeTps?: number;
  running?: number;
}

export function parseNinferThroughput(line: string): NinferThroughput | undefined {
  const msg = ninferMessage(line);
  const m = /^throughput \| ([\d.]+)s\b(.*)$/.exec(msg);
  if (!m) return undefined;
  const rest = m[2] as string;
  const prefill = /prefill ([\d.]+k?) tok\/s/.exec(rest);
  const decode = /decode ([\d.]+k?) tok\/s/.exec(rest);
  const running = /running (\d+)/.exec(rest);
  return {
    intervalSec: Number(m[1]),
    ...(prefill ? { prefillTps: rate(prefill[1] as string) } : {}),
    ...(decode ? { decodeTps: rate(decode[1] as string) } : {}),
    ...(running ? { running: Number(running[1]) } : {}),
  };
}

/** The line the WSL launcher prints before it becomes ninfer-serve (core/engines/ninfer/wsl.ts). */
export const PID_LINE = /^gpubench-pid (\d+)\s*$/;

/** The detail of NInfer's own start-up failure ("server failed during startup | <detail>", "warmup failed | <time> | <detail>"). */
export function startupFailure(lines: readonly string[]): string | undefined {
  for (const l of lines) {
    const msg = ninferMessage(l);
    const m = /^server failed during startup \| (.+)$/.exec(msg) ?? /^warmup failed \| [^|]+ \| (.+)$/.exec(msg);
    if (m) return (m[1] as string).trim();
  }
  return undefined;
}

/** A model this build cannot read, from the artifact reader's own words (a property of the model and the build: every launch fails the same). */
export interface UnreadableModel {
  reason: 'layout' | 'format' | 'container' | 'architecture';
  /** The layout, format or architecture it did not know ("gguf_blocks_v1"), or the artifact's container ("v2"). */
  value: string;
  /** Container: the version this build reads ("v3"). */
  needs?: string;
  /** Container: NInfer's own upgrade command, as it printed it. */
  command?: string;
}

export function unreadableModel(text: string): UnreadableModel | undefined {
  const layout = /unknown tensor (layout|format): ([A-Za-z0-9_.-]+)/.exec(text);
  if (layout) return { reason: layout[1] as 'layout' | 'format', value: layout[2] as string };
  const old = /NInfer v(\d+) artifact is not supported(?:\. Upgrade to v(\d+) with: ([^\n]+))?/.exec(text);
  if (old) return { reason: 'container', value: `v${old[1]}`, ...(old[2] ? { needs: `v${old[2]}` } : {}), ...(old[3] ? { command: (old[3] as string).trim() } : {}) };
  const arch = /(?:unsupported|unknown) model (?:architecture|family|type)[:\s]+'?([A-Za-z0-9_.-]+)/i.exec(text);
  return arch ? { reason: 'architecture', value: arch[1] as string } : undefined;
}

/** ENGINE_MODEL_UNSUPPORTED for a model `engine` (its name, its build) cannot read; the variant that reads it, when one is known. */
export function modelUnsupported(engine: string, u: UnreadableModel, o: { build?: string | undefined; detail?: string } = {}): AppError {
  const tpl = u.reason === 'layout' || u.reason === 'format' ? templateForLayout(u.value) : undefined;
  const params: Record<string, string> = {
    engine,
    reason: u.reason,
    value: u.value,
    ...(o.build ? { build: o.build } : {}),
    ...(u.needs ? { needs: u.needs } : {}),
    ...(u.command ? { command: u.command } : {}),
    ...(tpl ? { template: tpl.id, variant: tpl.label } : {}),
  };
  return new AppError('ENGINE_MODEL_UNSUPPORTED', `${engine} cannot read this model (${u.reason} ${u.value})`, { params, ...(o.detail ? { detail: o.detail } : {}) });
}

export interface NinferDiagnoseOptions {
  kvTokens?: number;
  bytesPerToken?: number;
  distro?: string;
  /** The build's commit (short), for the message. */
  build?: string;
}

/**
 * Why a start failed, from ninfer-serve's own lines. The runtime reservation it could not make says
 * how many tokens would have fit (`estimatedMaxModelLen`, the tuner's next candidate), given what one
 * token of the KV pool takes and the capacity asked for. A model the build cannot read is
 * ENGINE_MODEL_UNSUPPORTED (the tuner and the runner stop at once: every launch would fail the same).
 */
export function diagnoseNinfer(lines: readonly string[], exit: ExitInfo, o: NinferDiagnoseOptions = {}): AppError {
  const tail = lines.slice(-40).join('\n');
  const code = String(exit.code ?? exit.signal);
  const all = lines.join('\n');
  const reservation = /requires (\d+) bytes, but only (\d+) bytes are available/.exec(all);
  if (reservation) {
    const need = Number(reservation[1]);
    const have = Number(reservation[2]);
    const params: Record<string, number | string> = { needMiB: Math.round(need / 1024 ** 2), availableMiB: Math.round(have / 1024 ** 2), reason: 'ninfer-reservation' };
    if (o.kvTokens !== undefined && o.bytesPerToken !== undefined && o.bytesPerToken > 0) {
      const fits = Math.floor((o.kvTokens - (need - have) / o.bytesPerToken) / 1024) * 1024;
      if (fits > 0) params.estimatedMaxModelLen = fits;
    }
    return new AppError('ENGINE_OOM', 'NInfer cannot reserve its runtime memory', { params, detail: tail });
  }
  if (/out of memory|cudaErrorMemoryAllocation|CUDA_ERROR_OUT_OF_MEMORY/i.test(all)) return new AppError('ENGINE_OOM', 'Out of GPU memory', { params: { code }, detail: tail });
  if (/address already in use|EADDRINUSE|failed to bind|cannot bind \S+:\d+/i.test(all)) return new AppError('ENGINE_PORT_IN_USE', 'The port is already in use', { params: { code }, detail: tail });
  const lib = missingLibrary(all);
  if (lib) return new AppError('ENGINE_MISSING_LIBRARY', `NInfer: the system library ${lib.library} is missing`, { params: { library: lib.library, package: lib.package }, detail: tail });
  const unreadable = unreadableModel(all);
  if (unreadable) return modelUnsupported('NInfer', unreadable, { build: o.build, detail: tail });
  if (/no kernel image|sm_120a|unsupported (GPU|device|architecture)|requires an? (NVIDIA )?(GeForce )?RTX 5090/i.test(all)) {
    return new AppError('ENGINE_GPU_UNSUPPORTED', 'NInfer cannot run on this GPU', { params: { engine: 'NInfer', gpu: 'RTX 5090' }, detail: tail });
  }
  if (/container[_ ]version|entry magic|unsupported artifact|invalid artifact|not a \.?ninfer/i.test(all)) {
    return new AppError('MODEL_INVALID', 'NInfer cannot read this artifact', { params: { reason: 'ninfer-artifact' }, detail: tail });
  }
  // --lm-head-draft on an artifact without the optimized proposal head (GGUF-NInfer ones).
  if (/selected proposal head is absent from artifact/i.test(all)) {
    return new AppError('ENGINE_BAD_FLAG', 'This model has no proposal head for --lm-head-draft', { params: { flag: '--lm-head-draft', reason: 'proposal_head_missing' }, detail: tail });
  }
  // A value the build does not take ("invalid kv-dtype: rk8v4": a variant's KV type on the official build).
  const value = /invalid (kv-dtype|spec|draft-tokens|kv-capacity)[:\s]+'?([\w.-]+)/i.exec(all);
  if (value) return new AppError('ENGINE_BAD_FLAG', `NInfer does not take --${value[1]} ${value[2]}`, { params: { flag: `--${(value[1] as string).toLowerCase()}`, value: value[2] as string }, detail: tail });
  const flag = /(?:unknown|unrecognized) (?:option|argument)[:\s]+'?(--?[\w-]+)/i.exec(all);
  if (flag) return new AppError('ENGINE_BAD_FLAG', `NInfer does not know ${flag[1]}`, { params: { flag: flag[1] as string }, detail: tail });
  if (/There is no distribution with the supplied name|WSL_E_DISTRO_NOT_FOUND/i.test(all)) {
    return new AppError('ENGINE_NOT_INSTALLED', 'The WSL distro does not exist', { params: { reason: 'distro_missing', ...(o.distro ? { distro: o.distro } : {}) }, detail: tail });
  }
  if (/exec: .*: not found|No such file or directory|cannot execute/i.test(all)) {
    return new AppError('ENGINE_NOT_INSTALLED', 'ninfer-serve was not found', { params: { reason: 'ninfer_not_found' }, detail: tail });
  }
  // NInfer said why it stopped: its words are the message (the details keep the last lines).
  const said = startupFailure(lines);
  return new AppError('ENGINE_EXITED', said ? `ninfer-serve exited with ${code}: ${said}` : `ninfer-serve exited with ${code}`, { params: { code }, detail: tail });
}
