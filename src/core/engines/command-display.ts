/**
 * Ready-to-paste renderings of an argv for "Mostra comando" / "Anteprima comando", plus
 * secret redaction applied before anything is displayed or stored in a run.
 *
 * The argv is always executed as an array (never through a shell); these strings are only
 * for humans, so they must round-trip exactly when pasted into PowerShell or bash.
 */

export interface CommandDisplay {
  powershell: string;
  bash: string;
}

/** PowerShell treats these four typographic quotes exactly like the ASCII single quote. */
const PS_SINGLE_QUOTES = /['\u2018\u2019\u201a\u201b]/g;

/**
 * Bare tokens that PowerShell passes verbatim: flags and simple words, plain decimal integers.
 * Everything else (paths, dotted hosts, `a,b` arrays, `1kb`-style numbers, `--%`) is quoted.
 */
const PS_SAFE = /^(?:-{1,2}[A-Za-z][A-Za-z0-9_-]*|[A-Za-z][A-Za-z0-9_-]*|-?[1-9][0-9]*|0)$/;

/** POSIX-shell safe characters (no expansion, globbing or word splitting). */
const SH_SAFE = /^[A-Za-z0-9_\-.,/:=+@%]+$/;
/** The command word must not look like an assignment or a job spec. */
const SH_SAFE_CMD = /^[A-Za-z0-9_\-.,/:+@]+$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function quotePowerShell(token: string): string {
  if (PS_SAFE.test(token)) return token;
  // Doubling repeats the same quote character: PowerShell keeps the second one literally.
  return `'${token.replace(PS_SINGLE_QUOTES, (q) => q + q)}'`;
}

/** A bare reserved word in command position would change the meaning of the line. */
const SH_RESERVED = new Set(
  'case coproc do done elif else esac fi for function if in select then time until while'.split(' '),
);

export function quoteBash(token: string, commandWord = false): string {
  const safe = commandWord ? SH_SAFE_CMD.test(token) && !SH_RESERVED.has(token) : SH_SAFE.test(token);
  if (safe) return token;
  return `'${token.replace(/'/g, `'\\''`)}'`;
}

/**
 * PowerShell: `$env:NAME='v'; & 'C:\path\llama-server.exe' -m 'C:\models\x.gguf' --port 8080`
 * bash:       `NAME='v' '/path/llama-server' -m /models/x.gguf --port 8080`
 * Pass already-redacted values (see redactArgv/redactEnv).
 */
export function displayCommand(argv: readonly string[], env: Readonly<Record<string, string>> = {}): CommandDisplay {
  const [cmd, ...args] = argv;
  if (cmd === undefined) return { powershell: '', bash: '' };
  const entries = Object.entries(env);

  const psEnv = entries.map(([k, v]) =>
    ENV_NAME.test(k) ? `$env:${k}=${quotePsValue(v)}; ` : `Set-Item -LiteralPath ${quotePsValue(`Env:${k}`)} -Value ${quotePsValue(v)}; `,
  );
  // `&` (call operator) is required whenever the program is a quoted string.
  const powershell = [`${psEnv.join('')}& ${quotePsValue(cmd)}`, ...args.map(quotePowerShell)].join(' ');

  // `NAME=v cmd` only works for identifiers; otherwise fall back to env(1) for all of them.
  const shEnv = entries.every(([k]) => ENV_NAME.test(k))
    ? entries.map(([k, v]) => `${k}=${quoteBash(v)}`)
    : ['env', ...entries.map(([k, v]) => quoteBash(`${k}=${v}`))];
  const bash = [...shEnv, quoteBash(cmd, true), ...args.map((a) => quoteBash(a))].join(' ');
  return { powershell, bash };
}

/** Commands around a server (LaunchPlan.steps), as argv arrays. */
export interface DisplaySteps {
  before: readonly (readonly string[])[];
  after: readonly (readonly string[])[];
}

/**
 * A server with commands before and after it (a program with an OpenAI API): one command per line in
 * the order they run, each group under a comment line (valid in PowerShell and bash) that says which.
 * `show` renders one command (already redacted, with its environment); without steps: `server` as it is.
 */
export function displayWithSteps(server: CommandDisplay, steps: DisplaySteps | undefined, show: (argv: readonly string[]) => CommandDisplay): CommandDisplay {
  if (!steps || (steps.before.length === 0 && steps.after.length === 0)) return server;
  const before = steps.before.map(show);
  const after = steps.after.map(show);
  const join = (shell: keyof CommandDisplay) =>
    [
      ...(before.length ? ['# before the server', ...before.map((d) => d[shell])] : []),
      '# the server',
      server[shell],
      ...(after.length ? ['# after the server stops', ...after.map((d) => d[shell])] : []),
    ].join('\n');
  return { powershell: join('powershell'), bash: join('bash') };
}

/** Values are always quoted in PowerShell assignments (a bare `1kb` would become 1024). */
function quotePsValue(v: string): string {
  return `'${v.replace(PS_SINGLE_QUOTES, (q) => q + q)}'`;
}

// ---------------------------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------------------------

export const HF_PLACEHOLDER = '<HF_TOKEN>';
export const API_KEY_PLACEHOLDER = '<API_KEY>';
export const TOKEN_PLACEHOLDER = '<TOKEN>';
export const SECRET_PLACEHOLDER = '<SECRET>';

const HF_NAMES = new Set(['HF_TOKEN', 'HUGGING_FACE_HUB_TOKEN', 'HUGGINGFACE_TOKEN', 'HUGGINGFACEHUB_API_TOKEN']);

/** Placeholder for an environment variable name, or undefined when the value is not secret. */
export function secretPlaceholder(name: string): string | undefined {
  const n = name.toUpperCase();
  if (HF_NAMES.has(n)) return HF_PLACEHOLDER;
  if (/(^|_)API_?KEY$/.test(n)) return API_KEY_PLACEHOLDER;
  if (/(^|_)TOKEN$/.test(n)) return TOKEN_PLACEHOLDER;
  if (/(^|_)(SECRET|PASSWORD|PASSWD)$/.test(n)) return SECRET_PLACEHOLDER;
  return undefined;
}

export function redactEnv(env: Readonly<Record<string, string>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) out[k] = v === '' ? v : (secretPlaceholder(k) ?? v);
  return out;
}

/** CLI flags whose next argument (or `=value`) is a secret. */
const SECRET_FLAGS: Readonly<Record<string, string>> = {
  '--api-key': API_KEY_PLACEHOLDER,
  '--hf-token': HF_PLACEHOLDER,
  '-hft': HF_PLACEHOLDER,
  '--token': TOKEN_PLACEHOLDER,
};

const AUTH_HEADER = /^(\s*(?:proxy-)?authorization\s*:\s*)(?:(bearer|basic|token)\s+)?.+$/i;

/**
 * Hides secrets in an argv: `--api-key X`, `--hf-token=X`, `-hft X`, docker `-e HF_TOKEN=X`
 * (any `NAME=value` whose NAME is secret), and `Authorization: Bearer X` header arguments.
 */
export function redactArgv(argv: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    const flagPlaceholder = SECRET_FLAGS[a];
    if (flagPlaceholder !== undefined && i + 1 < argv.length) {
      out.push(a, flagPlaceholder);
      i++;
      continue;
    }
    out.push(redactToken(a));
  }
  return out;
}

function redactToken(a: string): string {
  const eq = a.indexOf('=');
  if (eq > 0) {
    const name = a.slice(0, eq);
    const flag = SECRET_FLAGS[name];
    if (flag !== undefined) return `${name}=${flag}`;
    const ph = /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? secretPlaceholder(name) : undefined;
    if (ph !== undefined && eq < a.length - 1) return `${name}=${ph}`;
  }
  const auth = AUTH_HEADER.exec(a);
  if (auth) return `${auth[1]}${auth[2] ? `${auth[2]} ` : ''}${API_KEY_PLACEHOLDER}`;
  return a;
}
