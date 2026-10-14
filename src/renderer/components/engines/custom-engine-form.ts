/** The add/edit dialog's form ⇄ CustomEngineDraft: plain text fields, checked like the core checks them. */
import {
  COMMAND_STEPS_MAX,
  commandKvTypes,
  commandPlaceholders,
  commandSettingValues,
  commandStepsOf,
  customEngineDraftSchema,
  DEFAULT_COMMAND_KV,
  expandCommandTemplate,
  GIT_BRANCH,
  GIT_URL,
  splitCommandLine,
  unknownPlaceholders,
  type CommandKvType,
  type CommandPlaceholder,
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
  /** Programs with an OpenAI API: the commands before and after the server, one per line. */
  before: string;
  after: string;
  /** The values {kv} takes (asked only when a command uses {kv}). */
  kvTypes: CommandKvType[];
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

export type FormField = 'name' | 'path' | 'image' | 'template' | 'before' | 'after' | 'kvTypes' | 'repoUrl' | 'branch' | 'extraArgs' | 'env' | 'names';

/** What is wrong with a field: a message key under engines.custom.dialog, with values; `line` = which line of the field. */
export interface FieldProblem {
  key: string;
  params?: Record<string, string | number>;
  line?: number;
}

export const EMPTY_FORM: CustomEngineForm = {
  base: 'llamacpp',
  name: '',
  mode: 'native',
  path: '',
  image: '',
  template: '',
  api: 'completions',
  before: '',
  after: '',
  kvTypes: [...DEFAULT_COMMAND_KV],
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

/** The commands of a "one per line" field: blank lines skipped. */
export function commandLinesOf(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
}

/** The form's commands as the engine has them (for the placeholders in use and the preview). */
export function formCommands(f: Pick<CustomEngineForm, 'template' | 'before' | 'after'>): { template: string; before: string[]; after: string[] } {
  return { template: f.template.trim(), before: commandLinesOf(f.before), after: commandLinesOf(f.after) };
}

/** A command uses {kv}: the dialog asks which values it takes. */
export function usesKv(f: Pick<CustomEngineForm, 'template' | 'before' | 'after'>): boolean {
  return commandPlaceholders(formCommands(f)).includes('kv');
}

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
    before: r.mode === 'command' ? (r.before ?? []).join('\n') : '',
    after: r.mode === 'command' ? (r.after ?? []).join('\n') : '',
    kvTypes: r.mode === 'command' ? commandKvTypes(r) : [...DEFAULT_COMMAND_KV],
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
  const commands = formCommands(f);
  const kv = usesKv(f);
  if (mode === 'command' && kv && f.kvTypes.length === 0) problems.kvTypes = { key: 'kvTypesNone' };
  const run =
    mode === 'native'
      ? { mode, path: f.path.trim() }
      : mode === 'docker'
        ? { mode, image: f.image.trim() }
        : mode === 'ninfer'
          ? { mode, path: f.path.trim(), ...(distro ? { distro } : {}), ...(source ? { source } : {}) }
          : {
              mode,
              template: commands.template,
              api: f.api,
              ...(commands.before.length ? { before: commands.before } : {}),
              ...(commands.after.length ? { after: commands.after } : {}),
              // The KV types matter only to a command that takes {kv}.
              ...(kv && f.kvTypes.length ? { kvTypes: commandKvTypes({ kvTypes: f.kvTypes }) } : {}),
            };
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
  // What only the schema knows: the commands, the image name, the rules.
  const parsed = customEngineDraftSchema.safeParse(draft);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const reason = (issue as { params?: { reason?: string } }).params?.reason;
      const field = issue.path[1];
      // An empty template is too short for the schema; any other says why (templateProblem). The field is at most 4000 characters.
      if (field === 'template') problems.template ??= commandProblem(commands.template ? (reason as string) : 'empty', commands.template);
      else if (field === 'before' || field === 'after') {
        // Too many commands, or one too long, has no reason of its own.
        const i = issue.path[2];
        if (typeof i !== 'number') problems[field] ??= { key: 'tooMany', params: { max: COMMAND_STEPS_MAX } };
        else problems[field] ??= { ...(reason !== undefined ? commandProblem(reason, commands[field][i] as string) : { key: 'tooLong' }), line: i + 1 };
      } else if (field === 'image') problems.image ??= { key: 'badImage' };
      else if (issue.path[0] === 'match') problems.names ??= { key: 'badPattern' };
    }
  }
  return Object.keys(problems).length ? { problems } : { draft, problems };
}

// ---- programs with an OpenAI API -----------------------------------------------------------------

/** A ready-made program with an OpenAI API the dialog fills in (its name: engines.custom.dialog.examples.<id>). */
export interface CommandExample {
  id: 'llamacpp' | 'vllm' | 'python';
  template: string;
  before?: string;
  after?: string;
  api: 'completions' | 'chat';
  kvTypes?: CommandKvType[];
}

export const COMMAND_EXAMPLES: readonly CommandExample[] = [
  {
    id: 'llamacpp',
    template: 'llama-server -m {model} --host {host} --port {port} -a {alias} -c {ctx} -ctk {kv} -ctv {kv} -np {parallel} -ngl {gpuLayers} -b {batch} -ub {ubatch}',
    api: 'completions',
    kvTypes: ['f16', 'q8_0', 'q4_0'],
  },
  {
    id: 'vllm',
    template: 'vllm serve {model} --host {host} --port {port} --served-model-name {alias} --max-model-len {ctx} --kv-cache-dtype {kv} --max-num-seqs {parallel}',
    api: 'completions',
    kvTypes: ['auto', 'fp8'],
  },
  {
    id: 'python',
    before: 'python prepare.py --model {model}',
    template: 'python my_server.py --model {model} --port {port} --name {alias} --context {ctx}',
    after: 'python cleanup.py',
    api: 'chat',
  },
];

/** The form with an example's commands (its name and the rest of the form stay). */
export function withExample(f: CustomEngineForm, e: CommandExample): CustomEngineForm {
  return { ...f, template: e.template, before: e.before ?? '', after: e.after ?? '', api: e.api, kvTypes: [...(e.kvTypes ?? DEFAULT_COMMAND_KV)] };
}

/** One argument as it reads in a terminal: quoted when it holds spaces or quotes (the preview only: nothing runs it as text). */
const shown = (a: string) => (a === '' || /[\s"']/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a);

/** Example values of the placeholders for the preview: a model path with a space (it stays one argument). */
export function sampleValues(platform: string | undefined, kv: string): Record<CommandPlaceholder, string> {
  const win = platform === 'win32';
  const modelDir = win ? 'C:\\Models\\Qwen3 8B' : '/home/me/models/Qwen3 8B';
  return {
    model: `${modelDir}${win ? '\\' : '/'}Qwen3-8B-Q4_K_M.gguf`,
    modelDir,
    port: '8080',
    host: '127.0.0.1',
    alias: 'gpubench-3f2a9c',
    ...commandSettingValues({ kvTypes: [kv as CommandKvType] }, { contextSize: 8192, extraArgs: [], env: {} }),
  };
}

/**
 * The form's commands filled in with example values, one per line in the order they run, each group
 * under a comment line ("# before the server"…: comments for the reader), or undefined while a
 * command has a problem. `labels` are the comment lines in the user's language.
 */
export function commandPreview(f: CustomEngineForm, platform: string | undefined, labels: { before: string; server: string; after: string }): string | undefined {
  const { draft } = draftOf({ ...f, base: 'openai-server', mode: 'command', name: f.name.trim() || 'preview' });
  if (draft?.run.mode !== 'command') return undefined;
  const run = draft.run;
  const values = sampleValues(platform, commandKvTypes({ kvTypes: f.kvTypes.length ? f.kvTypes : [...DEFAULT_COMMAND_KV] })[0] as string);
  const line = (c: string) => expandCommandTemplate(c, values).map(shown).join(' ');
  const { before, after } = commandStepsOf(run);
  // draftOf already refused extra arguments with an open quote.
  const extra = splitCommandLine(f.extraArgs) as string[];
  const server = [line(run.template), ...extra.map(shown)].join(' ');
  return [
    ...(before.length ? [`# ${labels.before}`, ...before.map(line)] : []),
    ...(before.length || after.length ? [`# ${labels.server}`] : []),
    server,
    ...(after.length ? [`# ${labels.after}`, ...after.map(line)] : []),
  ].join('\n');
}

/** A command's problem in words: an unknown placeholder says which ones. */
function commandProblem(reason: string, line: string): FieldProblem {
  const unknown = reason === 'unknown_placeholder' ? unknownPlaceholders(line) : [];
  return { key: `templateProblems.${reason}`, ...(unknown.length ? { params: { names: unknown.map((p) => `{${p}}`).join(', ') } } : {}) };
}
