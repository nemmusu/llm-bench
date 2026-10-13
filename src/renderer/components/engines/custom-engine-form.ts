/** The add/edit dialog's form ⇄ CustomEngineDraft: plain text fields, checked like the core checks them. */
import {
  customEngineDraftSchema,
  splitCommandLine,
  type CustomEngine,
  type CustomEngineBase,
  type CustomEngineDraft,
  type CustomEngineTemplate,
} from '../../../contract/custom-engines';

export type EngineMode = 'native' | 'docker' | 'command';

export interface CustomEngineForm {
  base: CustomEngineBase;
  name: string;
  mode: EngineMode;
  path: string;
  image: string;
  template: string;
  api: 'completions' | 'chat';
  /** One line, split like a command line. */
  extraArgs: string;
  /** NAME=value, one per line. */
  env: string;
  /** Comma separated. */
  names: string;
  quants: string;
  notes: string;
  /** Built-in template it came from. */
  templateId?: string | undefined;
}

export type FormField = 'name' | 'path' | 'image' | 'template' | 'extraArgs' | 'env' | 'names';

/** What is wrong with a field: a message key under engines.custom.dialog, with values. */
export interface FieldProblem {
  key: string;
  params?: Record<string, string | number>;
}

export const EMPTY_FORM: CustomEngineForm = {
  base: 'llamacpp',
  name: '',
  mode: 'native',
  path: '',
  image: '',
  template: '',
  api: 'completions',
  extraArgs: '',
  env: '',
  names: '',
  quants: '',
  notes: '',
};

const list = (text: string): string[] =>
  text
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

/** The form of a saved engine (edit, duplicate). */
export function formOf(e: CustomEngine): CustomEngineForm {
  const r = e.run;
  return {
    base: e.base,
    name: e.name,
    mode: r.mode,
    path: r.mode === 'native' ? r.path : '',
    image: r.mode === 'docker' ? r.image : '',
    template: r.mode === 'command' ? r.template : '',
    api: r.mode === 'command' ? r.api : 'completions',
    extraArgs: e.extraArgs.map((a) => (/[\s"']/.test(a) ? (a.includes('"') ? `'${a}'` : `"${a}"`) : a)).join(' '),
    env: Object.entries(e.env)
      .map(([k, v]) => `${k}=${v}`)
      .join('\n'),
    names: e.match?.names.join(', ') ?? '',
    quants: e.match?.quants.join(', ') ?? '',
    notes: e.notes,
    templateId: e.template,
  };
}

/** A new engine from a built-in template: its base and rules, the name in the user's language. */
export function formOfTemplate(t: CustomEngineTemplate, name: string): CustomEngineForm {
  return { ...EMPTY_FORM, base: t.base, name, mode: 'native', names: t.match.names.join(', '), quants: t.match.quants.join(', '), templateId: t.id };
}

/** The mode a base takes: openai-server is always a command; a base keeps native/docker. */
export function modeFor(base: CustomEngineBase, mode: EngineMode): EngineMode {
  if (base === 'openai-server') return 'command';
  return mode === 'command' ? 'native' : mode;
}

/** The draft to send, or what is wrong, field by field. */
export function draftOf(f: CustomEngineForm): { draft?: CustomEngineDraft; problems: Partial<Record<FormField, FieldProblem>> } {
  const problems: Partial<Record<FormField, FieldProblem>> = {};
  const mode = modeFor(f.base, f.mode);
  if (!f.name.trim()) problems.name = { key: 'required' };
  if (mode === 'native' && !f.path.trim()) problems.path = { key: 'required' };
  if (mode === 'docker' && !f.image.trim()) problems.image = { key: 'required' };
  const extraArgs = splitCommandLine(f.extraArgs);
  if (extraArgs === undefined) problems.extraArgs = { key: 'templateProblems.unbalanced_quote' };
  const env: Record<string, string> = {};
  f.env.split(/\r?\n/).forEach((line, i) => {
    if (!line.trim()) return;
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line);
    if (m) env[m[1] as string] = (m[2] as string).trim();
    else problems.env ??= { key: 'envInvalid', params: { line: i + 1 } };
  });
  const names = list(f.names);
  const quants = list(f.quants);
  const run =
    mode === 'native' ? { mode, path: f.path.trim() } : mode === 'docker' ? { mode, image: f.image.trim() } : { mode, template: f.template.trim(), api: f.api };
  const draft: CustomEngineDraft = {
    name: f.name.trim(),
    base: f.base,
    run,
    extraArgs: extraArgs ?? [],
    env,
    notes: f.notes.trim(),
    ...(names.length || quants.length ? { match: { names, quants } } : {}),
    ...(f.templateId ? { template: f.templateId } : {}),
  };
  // What only the schema knows: the command template, the image name, the rules.
  const parsed = customEngineDraftSchema.safeParse(draft);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const reason = (issue as { params?: { reason?: string } }).params?.reason;
      const field = issue.path[1];
      // An empty template is too short for the schema; any other says why (templateProblem). The field is at most 4000 characters.
      if (field === 'template') problems.template ??= { key: `templateProblems.${f.template.trim() ? (reason as string) : 'empty'}` };
      else if (field === 'image') problems.image ??= { key: 'badImage' };
      else if (issue.path[0] === 'match') problems.names ??= { key: 'badPattern' };
    }
  }
  return Object.keys(problems).length ? { problems } : { draft, problems };
}
