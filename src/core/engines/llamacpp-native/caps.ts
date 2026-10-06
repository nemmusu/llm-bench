import { promises as fs } from 'node:fs';
import { AppError } from '../../../contract/errors';
import type { ProcessRunner } from '../../deps';
import type { EngineCaps } from '../types';

/** One option block of `llama-server --help`. */
export interface HelpEntry {
  /** All spellings, e.g. ["-ngl", "--gpu-layers", "--n-gpu-layers"]. */
  names: string[];
  /** Value placeholder as printed, e.g. "N", "[on|off|auto]", "TYPE". */
  placeholder?: string;
  /** Enumerated values when the placeholder lists them ("[on|off|auto]", "{none,layer,row}", "<0|1>"). */
  values?: string[];
  desc: string;
}

const NAME = /[ \t]*(-{1,2}[A-Za-z0-9][A-Za-z0-9_-]*)(,)?/y;

/**
 * Parses the option table. Option lines start at column 0 with "-"; spellings are separated
 * by commas (padding after a comma varies: "-h,    --help"), then an optional placeholder,
 * then two or more spaces and the description, which continues on indented lines.
 */
export function parseHelp(text: string): HelpEntry[] {
  const entries: HelpEntry[] = [];
  let current: HelpEntry | undefined;
  for (const line of text.split(/\r?\n/)) {
    if (/^-{1,2}[A-Za-z0-9]/.test(line)) {
      const names: string[] = [];
      let pos = 0;
      for (;;) {
        NAME.lastIndex = pos;
        const m = NAME.exec(line);
        if (!m) break;
        names.push(m[1] as string);
        pos = NAME.lastIndex;
        if (!m[2]) break;
      }
      const rest = line.slice(pos);
      const ph = /^ (\S+(?: \S+)*?)(?: {2,}|$)/.exec(rest)?.[1];
      current = { names, desc: rest.slice(ph === undefined ? 0 : ph.length + 1).trim() };
      if (ph !== undefined) {
        current.placeholder = ph;
        const list = /^[[{<]([^\]}>]*[|,][^\]}>]*)[\]}>]$/.exec(ph)?.[1];
        if (list !== undefined) current.values = list.split(/[|,]/).map((v) => v.trim());
      }
      entries.push(current);
    } else if (current && /^\s+\S/.test(line)) {
      current.desc = `${current.desc} ${line.trim()}`.trim();
    } else {
      current = undefined;
    }
  }
  return entries;
}

export interface VersionInfo {
  /** "0.4.1-dev" (new builds) or "b4589" (old builds that only print the build number). */
  version?: string;
  /** "b10997". */
  build?: string;
  commit?: string;
  builtWith?: string;
}

/**
 * `--version` (printed on stderr):
 *   new: "version: 0.4.1-dev (build 10997, commit fccf7166f)"
 *   old: "version: 4589 (a4417ddd)"
 *   "built with Clang 20.1.8 for Windows x86_64"
 */
export function parseVersion(text: string): VersionInfo {
  const out: VersionInfo = {};
  const modern = /^version:\s*(\S+)\s*\(build\s+(\d+),\s*commit\s+([0-9a-f]+)\)/m.exec(text);
  const legacy = /^version:\s*(\d+)\s*\(([0-9a-f]+)\)/m.exec(text);
  if (modern) {
    out.version = modern[1] as string;
    out.build = `b${modern[2] as string}`;
    out.commit = modern[3] as string;
  } else if (legacy) {
    out.build = `b${legacy[1] as string}`;
    out.version = out.build;
    out.commit = legacy[2] as string;
  }
  const built = /^built with (.+)$/m.exec(text)?.[1];
  if (built !== undefined) out.builtWith = built.trim();
  return out;
}

export interface LlamaCaps extends EngineCaps {
  commit?: string;
  builtWith?: string;
  /** Current builds take `-fa on|off|auto`; old ones had a bare `-fa` toggle. */
  flashAttn: 'value' | 'toggle' | 'none';
  /** Keywords accepted by -ngl besides a number (current builds: "auto", "all"). */
  nglKeywords: string[];
  /** Allowed -ctk/-ctv values. */
  cacheTypes: string[];
  entries: HelpEntry[];
}

export function capsFromOutputs(versionText: string, helpText: string): LlamaCaps {
  const v = parseVersion(versionText);
  const entries = parseHelp(helpText);
  const flags = new Set(entries.flatMap((e) => e.names));
  const entry = (name: string) => entries.find((e) => e.names.includes(name));
  const fa = entry('--flash-attn');
  const ngl = entry('--n-gpu-layers');
  const ctk = entry('--cache-type-k');
  const caps: LlamaCaps = {
    flags,
    // llama.cpp /completion accepts token-id prompts and reports `timings`; it has no min_tokens
    // (exact output length comes from ignore_eos + n_predict).
    tokenIdsInPrompt: true,
    timings: true,
    minTokens: false,
    fitFlag: flags.has('--fit'),
    flashAttn: fa ? (fa.values ? 'value' : 'toggle') : 'none',
    nglKeywords: ngl ? [...ngl.desc.matchAll(/'(auto|all)'/g)].map((m) => m[1] as string) : [],
    cacheTypes: ctk ? (/allowed values:\s*([^()]+?)(?:\s*\(|$)/.exec(ctk.desc)?.[1]?.split(/,\s*/) ?? []) : [],
    entries,
  };
  if (v.version !== undefined) caps.version = v.version;
  if (v.build !== undefined) caps.build = v.build;
  if (v.commit !== undefined) caps.commit = v.commit;
  if (v.builtWith !== undefined) caps.builtWith = v.builtWith;
  return caps;
}

/**
 * What a current llama-server supports, for previewing the command of a build that is not
 * installed yet (the install picks the newest release): -fa on|off|auto, -ngl all, --fit,
 * --kv-unified, --no-webui. The real build is probed once installed.
 */
export function currentLlamaCaps(): LlamaCaps {
  return {
    flags: new Set(['--flash-attn', '-fa', '--n-gpu-layers', '-ngl', '--cache-type-k', '-ctk', '--cache-type-v', '-ctv', '--fit', '--kv-unified', '--no-webui']),
    tokenIdsInPrompt: true,
    timings: true,
    minTokens: false,
    fitFlag: true,
    flashAttn: 'value',
    nglKeywords: ['auto', 'all'],
    cacheTypes: ['f32', 'f16', 'bf16', 'q8_0', 'q4_0', 'q4_1', 'iq4_nl', 'q5_0', 'q5_1'],
    entries: [],
  };
}

/**
 * Variant of a custom build guessed from the files next to the binary (cudart64_13.dll,
 * libggml-cuda.so, ggml-vulkan.dll…). Managed builds know their variant from install.json.
 */
export function guessVariant(files: readonly string[]): string {
  const lower = files.map((f) => f.toLowerCase());
  for (const f of lower) {
    const m = /^cudart64_(\d+)\.dll$/.exec(f) ?? /^libcudart\.so\.(\d+)/.exec(f);
    if (m) return `cuda-${m[1] as string}`;
  }
  if (lower.some((f) => /^(lib)?ggml-cuda\.(dll|so)/.test(f))) return 'cuda';
  if (lower.some((f) => /^(lib)?ggml-vulkan\.(dll|so)/.test(f))) return 'vulkan';
  return 'cpu';
}

export interface ProbeResult extends VersionInfo {
  ok: boolean;
  code: number | null;
  output: string;
}

/**
 * Runs `--version` / `--help` once per binary and caches the result by path + size + mtime,
 * so replacing the binary (update, rebuild) is noticed without probing on every request.
 */
export class CapsProbe {
  private readonly versions = new Map<string, Promise<ProbeResult>>();
  private readonly caps = new Map<string, Promise<LlamaCaps>>();

  constructor(
    private readonly proc: ProcessRunner,
    private readonly timeoutMs = 60_000,
    private readonly stat: (p: string) => Promise<{ size: number; mtimeMs: number }> = (p) => fs.stat(p),
  ) {}

  /** `argv` = launcher prefix + binary path (the last element is the file that identifies the build). */
  async version(argv: readonly string[], env: Record<string, string> = {}): Promise<ProbeResult> {
    const key = await this.key(argv);
    let p = this.versions.get(key);
    if (!p) {
      p = this.runVersion(argv, env);
      this.versions.set(key, p);
    }
    return p;
  }

  async probe(argv: readonly string[], env: Record<string, string> = {}): Promise<LlamaCaps> {
    const key = await this.key(argv);
    let p = this.caps.get(key);
    if (!p) {
      p = this.runCaps(argv, env);
      this.caps.set(key, p);
      // Failures are not cached: the user may fix the binary (missing DLL) and retry.
      p.catch(() => this.caps.delete(key));
    }
    return p;
  }

  private async key(argv: readonly string[]): Promise<string> {
    const st = await this.stat(argv[argv.length - 1] as string).catch(() => ({ size: -1, mtimeMs: -1 }));
    return `${JSON.stringify(argv)}|${st.size}|${st.mtimeMs}`;
  }

  private async runVersion(argv: readonly string[], env: Record<string, string>): Promise<ProbeResult> {
    const [cmd, ...pre] = argv as [string, ...string[]];
    const out = await this.proc.run(cmd, [...pre, '--version'], { timeoutMs: this.timeoutMs, env });
    const output = `${out.stderr}\n${out.stdout}`.trim();
    const info = parseVersion(output);
    return { ...info, ok: out.code === 0 && info.build !== undefined, code: out.code, output };
  }

  private async runCaps(argv: readonly string[], env: Record<string, string>): Promise<LlamaCaps> {
    const [cmd, ...pre] = argv as [string, ...string[]];
    const v = await this.version(argv, env);
    const help = await this.proc.run(cmd, [...pre, '--help'], { timeoutMs: this.timeoutMs, env });
    const text = `${help.stdout}\n${help.stderr}`;
    if (help.code !== 0 || parseHelp(text).length === 0) {
      throw new AppError('ENGINE_START_FAILED', `${cmd} --help failed`, {
        params: { code: String(help.code) },
        detail: text.trim().slice(0, 2000),
      });
    }
    return capsFromOutputs(v.output, text);
  }
}
