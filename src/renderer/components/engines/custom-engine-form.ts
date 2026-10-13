/** The add/edit dialog's form ⇄ CustomEngineDraft: plain text fields, checked like the core checks them. */
import {
  customEngineDraftSchema,
  GIT_BRANCH,
  GIT_URL,
  splitCommandLine,
  type CustomEngine,
  type CustomEngineBase,
  type CustomEngineDraft,
  type CustomEngineTemplate,
} from '../../../contract/custom-engines';

export type EngineMode = 'native' | 'docker' | 'command' | 'ninfer';

export interface CustomEngineForm {
  base: CustomEngineBase;
  name: string;
  mode: EngineMode;
  path: string;
  image: string;
  template: string;
  api: 'completions' | 'chat';
  /** NInfer variants: the WSL distro it runs in (Windows), and the repository its guided build clones. */
  distro: string;
  repoUrl: string;
  branch: string;
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

export type FormField = 'name' | 'path' | 'image' | 'template' | 'repoUrl' | 'branch' | 'extraArgs' | 'env' | 'names';

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
  distro: '',
  repoUrl: '',
  branch: '',
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
    path: r.mode === 'native' || r.mode === 'ninfer' ? r.path : '',
    image: r.mode === 'docker' ? r.image : '',
    template: r.mode === 'command' ? r.template : '',
    api: r.mode === 'command' ? r.api : 'completions',
    distro: r.mode === 'ninfer' ? (r.distro ?? '') : '',
    repoUrl: r.mode === 'ninfer' ? (r.source?.url ?? '') : '',
    branch: r.mode === 'ninfer' ? (r.source?.branch ?? '') : '',
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

/** A new engine from a built-in template: its base, rules and (a NInfer variant) repository, the name in the user's language. */
export function formOfTemplate(t: CustomEngineTemplate, name: string): CustomEngineForm {
  return {
    ...EMPTY_FORM,
    base: t.base,
    name,
    mode: modeFor(t.base, 'native'),
    names: t.match.names.join(', '),
    quants: t.match.quants.join(', '),
    repoUrl: t.source?.url ?? '',
    branch: t.source?.branch ?? '',
    templateId: t.id,
  };
}

/** The mode a base takes: openai-server is always a command, a NInfer variant always 'ninfer'; a fork keeps native/docker. */
export function modeFor(base: CustomEngineBase, mode: EngineMode): EngineMode {
  if (base === 'openai-server') return 'command';
  if (base === 'ninfer') return 'ninfer';
  return mode === 'command' || mode === 'ninfer' ? 'native' : mode;
}

/** A NInfer variant's repository as the form has it: undefined when empty, else its URL and branch (checked by draftOf). */
export function sourceOfForm(f: Pick<CustomEngineForm, 'repoUrl' | 'branch'>): { url: string; branch?: string } | undefined {
  const url = f.repoUrl.trim();
  if (!url) return undefined;
  const branch = f.branch.trim();
  return { url, ...(branch ? { branch } : {}) };
}

/** The draft to send, or what is wrong, field by field. */
export function draftOf(f: CustomEngineForm): { draft?: CustomEngineDraft; problems: Partial<Record<FormField, FieldProblem>> } {
  const problems: Partial<Record<FormField, FieldProblem>> = {};
  const mode = modeFor(f.base, f.mode);
  if (!f.name.trim()) problems.name = { key: 'required' };
  if ((mode === 'native' || mode === 'ninfer') && !f.path.trim()) problems.path = { key: 'required' };
  const source = mode === 'ninfer' ? sourceOfForm(f) : undefined;
  if (source && !GIT_URL.test(source.url)) problems.repoUrl = { key: 'badRepo' };
  if (source?.branch !== undefined && !GIT_BRANCH.test(source.branch)) problems.branch = { key: 'badBranch' };
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
  const distro = f.distro.trim();
  const run =
    mode === 'native'
      ? { mode, path: f.path.trim() }
      : mode === 'docker'
        ? { mode, image: f.image.trim() }
        : mode === 'ninfer'
          ? { mode, path: f.path.trim(), ...(distro ? { distro } : {}), ...(source ? { source } : {}) }
          : { mode, template: f.template.trim(), api: f.api };
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
