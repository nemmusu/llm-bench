/**
 * nvidia-smi `--query-*` CSV helpers. nvidia-smi never quotes values, pads with spaces and
 * reports missing data as placeholders ("[N/A]", "[Not Supported]", "[Unknown Error]"…),
 * so every value is parsed defensively.
 */

/** One logical column: `names` are alternative query names in preference order (old drivers know older aliases). */
export interface FieldSpec {
  key: string;
  names: readonly [string, ...string[]];
  /** The query is useless without it (e.g. `index`, used to group lines per GPU). */
  required?: boolean;
  /** Kept in the reduced list used when an old driver rejects a field we cannot identify. */
  minimal?: boolean;
}

/** Chosen query name per key; `null` = dropped because the driver does not know any alias. */
export type FieldChoice = Record<string, string | null>;

export interface ActiveField {
  key: string;
  name: string;
}

export function initialChoice(specs: readonly FieldSpec[]): FieldChoice {
  const out: FieldChoice = {};
  for (const s of specs) out[s.key] = s.names[0];
  return out;
}

export function minimalChoice(specs: readonly FieldSpec[]): FieldChoice {
  const out: FieldChoice = {};
  for (const s of specs) out[s.key] = s.minimal || s.required ? s.names[0] : null;
  return out;
}

export function activeFields(specs: readonly FieldSpec[], choice: FieldChoice): ActiveField[] {
  const out: ActiveField[] = [];
  for (const s of specs) {
    const name = choice[s.key];
    if (name) out.push({ key: s.key, name });
  }
  return out;
}

/**
 * Applies an "unsupported field" error to the choice: switches that column to its next alias or
 * drops it. Returns undefined when the field is unknown to us or required (caller falls back).
 */
export function withoutField(specs: readonly FieldSpec[], choice: FieldChoice, rejected: string): FieldChoice | undefined {
  const spec = specs.find((s) => choice[s.key] === rejected);
  if (!spec || spec.required) return undefined;
  const next = spec.names[spec.names.indexOf(rejected) + 1] ?? null;
  return { ...choice, [spec.key]: next };
}

const UNSUPPORTED_RE = /is not a valid field to query/i;
const UNSUPPORTED_NAME_RE = /Field "([^"]+)" is not a valid field to query/i;

/**
 * Detects nvidia-smi's "Field "x" is not a valid field to query." message. Windows exits 2 but
 * WSL exits 0 with the message on stdout, so the text is checked regardless of the exit code.
 * Returns the field name, '' when the message is present but the name cannot be read, or undefined.
 */
export function unsupportedField(text: string): string | undefined {
  if (!UNSUPPORTED_RE.test(text)) return undefined;
  return UNSUPPORTED_NAME_RE.exec(text)?.[1] ?? '';
}

/**
 * Splits one CSV row into exactly `count` trimmed cells. nvidia-smi does not quote, so a free-text
 * column (GPU or process name) may contain commas: extra cells are merged back into `freeText`.
 */
export function splitRow(line: string, count: number, freeText?: number): string[] | undefined {
  const parts = line.split(',');
  if (parts.length === count) return parts.map((p) => p.trim());
  if (freeText === undefined || parts.length < count) return undefined;
  const extra = parts.length - count;
  const merged = parts.slice(freeText, freeText + extra + 1).join(',');
  return [...parts.slice(0, freeText), merged, ...parts.slice(freeText + extra + 1)].map((p) => p.trim());
}

/** Numeric cell → number, or null for placeholders ("[N/A]", "[Not Supported]", "N/A", ""…). Tolerates units. */
export function num(cell: string | undefined): number | null {
  if (cell === undefined) return null;
  const m = /^\s*(-?\d+(?:\.\d+)?)(?:\s*[A-Za-z%]+)?\s*$/.exec(cell);
  return m?.[1] === undefined ? null : Number(m[1]);
}

/** Text cell → trimmed string, or null for empty values and bracketed placeholders. */
export function text(cell: string | undefined): string | null {
  const v = cell?.trim();
  if (!v || /^\[.*\]$/.test(v) || v === 'N/A') return null;
  return v;
}

/** Row cells indexed by key (columns follow the active field list). */
export function byKey(fields: readonly ActiveField[], cells: readonly string[]): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  fields.forEach((f, i) => {
    out[f.key] = cells[i];
  });
  return out;
}

/** Non-empty lines of a command output (CRLF tolerant). */
export function lines(output: string): string[] {
  return output
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}
