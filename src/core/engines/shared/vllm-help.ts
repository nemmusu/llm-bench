/**
 * What an installed vLLM accepts, from `vllm serve --help=all` (v0.10+, grouped help) or `--help`
 * (older): every option spelling and the choices argparse lists for it. The tuner only searches
 * what the installed version has (--block-size, --cuda-graph-sizes or --compilation-config,
 * fp8_e4m3 / fp8_e5m2 caches).
 *
 * argparse prints one option per line, indented, spellings separated by commas, choices in braces:
 *   "  --block-size {1,8,16,32,64,128}"
 *   "  --enable-prefix-caching, --no-enable-prefix-caching"
 *   "  --compilation-config COMPILATION_CONFIG, -O COMPILATION_CONFIG"
 * The description follows after two or more spaces, or on the next lines (indented further).
 */

export interface VllmHelp {
  flags: Set<string>;
  /** Choices of an option, by each of its spellings ("--kv-cache-dtype" → ["auto", "fp8", "fp8_e4m3", …]). */
  choices: Record<string, string[]>;
}

const OPTION_LINE = /^ {1,8}(-{1,2}[A-Za-z0-9].*?)(?: {2,}|$)/;
const SPELLING = /^(-{1,2}[A-Za-z0-9][\w-]*)(?:[ =](\{[^}]*\}))?/;

export function parseVllmHelp(text: string): VllmHelp {
  const flags = new Set<string>();
  const choices: Record<string, string[]> = {};
  for (const line of text.split(/\r?\n/)) {
    const spec = OPTION_LINE.exec(line)?.[1];
    if (spec === undefined) continue;
    const names: string[] = [];
    let list: string[] | undefined;
    for (const part of spec.split(/,\s+/)) {
      const m = SPELLING.exec(part.trim());
      if (!m) continue;
      names.push(m[1] as string);
      if (m[2] !== undefined) list ??= (m[2] as string).slice(1, -1).split(',').map((c) => c.trim()).filter(Boolean);
    }
    for (const n of names) {
      flags.add(n);
      if (list) choices[n] = list;
    }
  }
  return { flags, choices };
}

export interface HelpRun {
  code: number | null;
  stdout: string;
  stderr: string;
}

/**
 * One plain `--help` (SGLang: argparse prints every option at once). A failure or an empty list gives
 * no options. `run` must not be called with anything else: without --help the program would start.
 */
export async function probeArgparseHelp(run: () => Promise<HelpRun>): Promise<VllmHelp> {
  const out = await run().catch(() => undefined);
  if (!out || out.code !== 0) return { flags: new Set(), choices: {} };
  const help = parseVllmHelp(`${out.stdout}\n${out.stderr}`);
  return help.flags.size > 1 ? help : { flags: new Set(), choices: {} };
}

/**
 * `--help=all` first (the full list on v0.10+; older versions reject it), then `--help`. A probe that
 * fails or lists nothing gives an empty help: the tuner then skips every optional dimension.
 */
export async function probeVllmHelp(run: (args: string[]) => Promise<HelpRun>): Promise<VllmHelp> {
  for (const args of [['--help=all'], ['--help']]) {
    const out = await run(args).catch(() => undefined);
    if (!out || out.code !== 0) continue;
    const help = parseVllmHelp(`${out.stdout}\n${out.stderr}`);
    if (help.flags.size > 1) return help;
  }
  return { flags: new Set(), choices: {} };
}
