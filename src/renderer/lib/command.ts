import type { Shell } from '../components/ui/code-block';

const SAFE_PS = /^[\w\-.:\\/=,+@]+$/;
const SAFE_SH = /^[\w\-.:/=,+@%]+$/;

/** Quotes one argument for PowerShell (single quotes are literal; ' doubles). */
export function quotePowerShell(arg: string): string {
  return SAFE_PS.test(arg) ? arg : `'${arg.replaceAll("'", "''")}'`;
}

/** Quotes one argument for POSIX shells. */
export function quoteBash(arg: string): string {
  return SAFE_SH.test(arg) ? arg : `'${arg.replaceAll("'", `'\\''`)}'`;
}

/**
 * Pretty, paste-ready multi-line command: one "--flag value" pair per line, env vars first.
 * Display only: the core always executes the argv array, never this string.
 */
export function formatCommand(argv: readonly string[], shell: Shell, env: Record<string, string> = {}): string {
  if (argv.length === 0) return '';
  const q = shell === 'powershell' ? quotePowerShell : quoteBash;
  const cont = shell === 'powershell' ? ' `' : ' \\';
  const lines: string[] = [];
  const envEntries = Object.entries(env);
  // PowerShell sets env vars as separate statements; bash prefixes them to the command.
  if (shell === 'powershell') for (const [k, v] of envEntries) lines.push(`$env:${k} = '${v.replaceAll("'", "''")}'`);
  const [exe, ...rest] = argv as [string, ...string[]];
  const exeQuoted = q(exe);
  const head =
    shell === 'powershell'
      ? exeQuoted.startsWith("'")
        ? `& ${exeQuoted}`
        : exeQuoted
      : `${envEntries.map(([k, v]) => `${k}=${quoteBash(v)} `).join('')}${exeQuoted}`;
  const groups: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    const next = rest[i + 1];
    // A flag owns the next token unless that token is itself a flag ("-1" is a value, "-v" is not).
    if (a.startsWith('-') && next !== undefined && !/^--?[A-Za-z]/.test(next)) {
      groups.push(`${q(a)} ${q(next)}`);
      i++;
    } else groups.push(q(a));
  }
  if (groups.length === 0) return [...lines, head].join('\n');
  lines.push(head + cont);
  groups.forEach((g, i) => lines.push(`  ${g}${i < groups.length - 1 ? cont : ''}`));
  return lines.join('\n');
}
