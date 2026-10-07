import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { LaunchParams } from '../../../contract/engines';
import { AppError } from '../../../contract/errors';
import type { Step } from '../../../contract/results';
import type { LlamaBenchResult, RunnerDeps } from '../../bench/runner';
import type { Platform, ProcessRunner } from '../../deps';
import { diagnoseExit } from '../llamacpp-native/logs';
import { llamaFlashAttention, llamaKvArgs } from '../shared/kv-flags';
import type { LaunchPlan } from '../types';

export type LlamaBenchStep = Extract<Step, { kind: 'llama-bench' }>;
export type LlamaBenchFn = NonNullable<RunnerDeps['llamaBench']>;

/**
 * How this build spells flash attention: `-fa <on|off|auto>` (2025+ builds, e.g. b10997),
 * `-fa <0|1>` (older builds), or no flag at all.
 */
export type FlashAttnStyle = 'value' | 'binary' | 'none';

export function llamaBenchExeName(platform: Platform): string {
  return platform === 'win32' ? 'llama-bench.exe' : 'llama-bench';
}

/** From `llama-bench --help`: "-fa, --flash-attn <on|off|auto>" vs "<0|1>". */
export function flashAttnStyle(help: string): FlashAttnStyle {
  const m = /^\s*-fa,\s*--flash-attn\s*<([^>]*)>/m.exec(help);
  if (!m) return 'none';
  return /\bon\b/.test(m[1] as string) ? 'value' : 'binary';
}

/** Value of `-m`/`--model` in the server argv (the file llama-server loads). */
export function modelFromArgv(argv: readonly string[]): string | undefined {
  for (let i = 0; i < argv.length - 1; i++) {
    if (argv[i] === '-m' || argv[i] === '--model') return argv[i + 1];
  }
  return undefined;
}

/** All layers on the GPU unless the user chose otherwise; llama-bench clamps 999 to the model's layer count. */
const ALL_LAYERS = 999;

/**
 * `llama-bench -m <model> -p <pp> -n <tg> -r <reps> -ngl <n> [-fa …] [-ctk/-ctv] [-b] [-ub] [-t] -o json`:
 * the same model and offload/attention/KV settings as the server run, so the numbers are comparable.
 */
export function buildLlamaBenchArgs(model: string, step: LlamaBenchStep, params: LaunchParams, fa: FlashAttnStyle): string[] {
  const args = ['-m', model, '-p', String(step.pp), '-n', String(step.tg), '-r', String(step.reps)];
  args.push('-ngl', String(params.gpuLayers ?? ALL_LAYERS));
  const want = llamaFlashAttention(params);
  if (fa === 'value') args.push('-fa', want);
  // Old builds have no "auto": leave their default (off) rather than guessing.
  else if (fa === 'binary' && want !== 'auto') args.push('-fa', want === 'on' ? '1' : '0');
  args.push(...llamaKvArgs(params));
  if (params.batchSize !== undefined) args.push('-b', String(params.batchSize));
  if (params.ubatchSize !== undefined) args.push('-ub', String(params.ubatchSize));
  if (params.threads !== undefined) args.push('-t', String(params.threads));
  args.push('-o', 'json');
  return args;
}

const entrySchema = z.object({
  n_prompt: z.number(),
  n_gen: z.number(),
  n_depth: z.number().optional(),
  avg_ts: z.number(),
  stddev_ts: z.number(),
});

/** llama-bench's own test label: pp512, tg128, pp512+tg128, with " @ d4096" for depth. */
export function testName(e: { n_prompt: number; n_gen: number; n_depth?: number }): string {
  const base = e.n_gen === 0 ? `pp${e.n_prompt}` : e.n_prompt === 0 ? `tg${e.n_gen}` : `pp${e.n_prompt}+tg${e.n_gen}`;
  return e.n_depth ? `${base} @ d${e.n_depth}` : base;
}

/** Parses `-o json` output (a JSON array on stdout); throws ENGINE_EXITED when there is none. */
export function parseLlamaBenchJson(stdout: string): LlamaBenchResult[] {
  const start = stdout.search(/^\[/m);
  const end = stdout.lastIndexOf(']');
  let raw: unknown;
  try {
    if (start < 0 || end < start) throw new Error('no JSON array');
    raw = JSON.parse(stdout.slice(start, end + 1));
  } catch (e) {
    throw new AppError('ENGINE_EXITED', 'llama-bench printed no JSON results', { params: { reason: 'bad-output' }, detail: stdout.slice(-2000), cause: e });
  }
  const parsed = z.array(entrySchema).safeParse(raw);
  if (!parsed.success || parsed.data.length === 0) {
    throw new AppError('ENGINE_EXITED', 'llama-bench printed no usable results', { params: { reason: 'bad-output' }, detail: stdout.slice(-2000) });
  }
  return parsed.data.map((e) => ({ test: testName(e), tps: e.avg_ts, stddev: e.stddev_ts }));
}

export interface LlamaBenchOptions {
  proc: ProcessRunner;
  platform: Platform;
  isFile?: (p: string) => Promise<boolean>;
  /** Argv placed before the binary (tests run a fake as `node fake.mjs`). */
  launcherPrefix?: string[];
  /** Whole-run timeout; default scales with the work (see defaultTimeoutMs). */
  timeoutMs?: (step: LlamaBenchStep) => number;
  helpTimeoutMs?: number;
}

/** 10 min for loading + generous per-token budgets (2 ms per prompt token, 200 ms per generated token). */
export function defaultTimeoutMs(step: LlamaBenchStep): number {
  return 600_000 + Math.max(1, step.reps) * (step.pp * 2 + step.tg * 200);
}

const defaultIsFile = (p: string) => fs.stat(p).then((s) => s.isFile(), () => false);

/** llama-bench lives next to the llama-server in use (same release archive / custom folder). */
export async function locateLlamaBench(plan: LaunchPlan, platform: Platform, isFile = defaultIsFile): Promise<string> {
  const server = plan.engine.executable ?? (plan.argv[0] as string);
  const bench = path.join(path.dirname(server), llamaBenchExeName(platform));
  if (!(await isFile(bench))) {
    throw new AppError('ENGINE_NOT_INSTALLED', `llama-bench not found next to ${server}`, { params: { tool: 'llama-bench', path: bench } });
  }
  return bench;
}

/**
 * Creates the BenchRunner's `llamaBench` dependency. Error mapping: binary missing →
 * ENGINE_NOT_INSTALLED, out of memory → ENGINE_OOM (via the llama.cpp log diagnosis), timeout →
 * ENGINE_TIMEOUT, abort → CANCELLED.
 */
export function createLlamaBench(o: LlamaBenchOptions): LlamaBenchFn {
  const prefix = o.launcherPrefix ?? [];
  const styles = new Map<string, Promise<FlashAttnStyle>>();

  const styleOf = (bench: string, env: Record<string, string>): Promise<FlashAttnStyle> => {
    let s = styles.get(bench);
    if (!s) {
      const argv = [...prefix, bench, '--help'];
      s = o.proc
        .run(argv[0] as string, argv.slice(1), { timeoutMs: o.helpTimeoutMs ?? 30_000, env })
        .then((out) => flashAttnStyle(`${out.stdout}\n${out.stderr}`), (): FlashAttnStyle => 'none');
      styles.set(bench, s);
    }
    return s;
  };

  return async (plan, step, signal) => {
    if (signal.aborted) throw new AppError('CANCELLED', 'llama-bench cancelled');
    const bench = await locateLlamaBench(plan, o.platform, o.isFile);
    const model = modelFromArgv(plan.argv) ?? plan.modelFiles[0];
    if (model === undefined) throw new AppError('MODEL_NOT_FOUND', 'No model file for llama-bench');
    const fa = await styleOf(bench, plan.env);
    const args = buildLlamaBenchArgs(model, step, plan.params, fa);
    const timeoutMs = (o.timeoutMs ?? defaultTimeoutMs)(step);
    const argv = [...prefix, bench, ...args];
    const out = await o.proc.run(argv[0] as string, argv.slice(1), { timeoutMs, signal, env: plan.env, cwd: path.dirname(bench) });
    if (signal.aborted) throw new AppError('CANCELLED', 'llama-bench cancelled');
    if (out.timedOut) throw new AppError('ENGINE_TIMEOUT', `llama-bench did not finish within ${timeoutMs} ms`, { params: { timeoutMs } });
    if (out.code === 0) return parseLlamaBenchJson(out.stdout);
    const lines = `${out.stderr}\n${out.stdout}`.split(/\r?\n/).filter((l) => l.trim() !== '');
    if (out.code === null && lines.some((l) => /\bENOENT\b/.test(l))) {
      throw new AppError('ENGINE_NOT_INSTALLED', `Cannot run ${bench}`, { params: { tool: 'llama-bench', path: bench } });
    }
    throw diagnoseExit(lines, { code: out.code, signal: null });
  };
}
