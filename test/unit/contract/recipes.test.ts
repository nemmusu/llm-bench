import { describe, expect, it } from 'vitest';
import { customEngineSchema, type CustomEngine } from '../../../src/contract/custom-engines';
import { launchParamsSchema, type LaunchParams } from '../../../src/contract/engines';
import {
  appliedRecipeSchema,
  argGroups,
  CONTEXT_200K,
  defaultYarnTarget,
  DRAFT_AUTO,
  extendedContext,
  mergeRecipeParams,
  modelEntryRank,
  modelRecipeDraftSchema,
  modelRecipeSchema,
  modelRecipesSettingSchema,
  partsOf,
  recipeArgTargetOf,
  recipeChoiceSchema,
  recipeCustomEngine,
  recipeForModel,
  recipeIdFor,
  recipeIsEmpty,
  recipeIsExactFor,
  recipePatchFor,
  recipeRank,
  RECIPE_TEMPLATES,
  recipeTemplate,
  SGLANG_MTP_ARGS,
  textMatcher,
  VLLM_MTP_ARGS,
  withTemplate,
  YARN_TARGETS,
  yarnScaling,
  type ModelRecipe,
  type RecipeModelRef,
  type RecipeTemplateModel,
} from '../../../src/contract/recipes';
import { settingsSchema } from '../../../src/contract/settings';

const SHA = 'a'.repeat(64);
const recipe = (over: Partial<ModelRecipe> & Record<string, unknown> = {}): ModelRecipe =>
  modelRecipeSchema.parse({ id: 'r', name: 'R', match: { models: [{ label: 'Qwen3 8B', weakKey: 'w' }] }, ...over });
const reasons = (r: { success: boolean; error?: { issues: { message: string }[] } }) => r.error?.issues.map((i) => i.message) ?? [];
const qwen: RecipeModelRef = { displayName: 'Qwen3 8B', repo: 'unsloth/Qwen3-8B-GGUF', file: 'Qwen3-8B-Q4_K_M.gguf', quant: 'Q4_K_M', weakKey: 'unsloth/Qwen3-8B-GGUF/Qwen3-8B-Q4_K_M.gguf/Q4_K_M/5', sha256: SHA };
const P = (over: Partial<LaunchParams> = {}): LaunchParams => ({ ...launchParamsSchema.parse({}), ...over });

describe('recipe schema', () => {
  it('fills defaults, keeps a format version and names its models', () => {
    const r = recipe();
    expect(r).toMatchObject({ schema: 1, args: {}, env: {}, notes: '', from: [] });
    expect(modelRecipeDraftSchema.safeParse({ name: 'x', match: { name: 'qwen3' } }).success).toBe(true);
  });

  it('needs models or a pattern, patterns that compile, and an identity for every model', () => {
    expect(reasons(modelRecipeDraftSchema.safeParse({ name: 'x', match: {} }))).toEqual(['no_models']);
    expect(reasons(modelRecipeDraftSchema.safeParse({ name: 'x', match: { name: '/(/' } }))).toEqual(['bad_pattern']);
    expect(reasons(modelRecipeDraftSchema.safeParse({ name: 'x', match: { quant: '/[/' } }))).toEqual(['bad_pattern']);
    expect(reasons(modelRecipeDraftSchema.safeParse({ name: 'x', match: { models: [{ label: 'only a label' }] } }))).toEqual(['identity_missing']);
    expect(modelRecipeSchema.safeParse({ id: 'Bad Id', name: 'x', match: { name: 'q' } }).success).toBe(false);
    expect(modelRecipeSchema.safeParse({ id: 'ok', name: 'x', match: { name: 'q' }, env: { 'NOT VALID': '1' } }).success).toBe(false);
  });

  it('settings drop an invalid recipe, never the whole file; the default is none', () => {
    const list = modelRecipesSettingSchema.parse([recipe(), { id: 'broken' }, recipe({ id: 'r2' })]);
    expect(list.map((r) => r.id)).toEqual(['r', 'r2']);
    expect(settingsSchema.parse({}).modelRecipes).toEqual([]);
    expect(settingsSchema.parse({ modelRecipes: [{ nonsense: true }], language: 'en' })).toMatchObject({ modelRecipes: [], language: 'en' });
  });

  it('an empty recipe is one to delete; any part makes it a recipe', () => {
    expect(recipeIsEmpty(recipe())).toBe(true);
    expect(recipeIsEmpty(recipe({ contextSize: 8192 }))).toBe(false);
    expect(recipeIsEmpty(recipe({ ropeScaling: { type: 'yarn', factor: 2, originalContext: 4096 } }))).toBe(false);
    expect(recipeIsEmpty(recipe({ draft: DRAFT_AUTO }))).toBe(false);
    expect(recipeIsEmpty(recipe({ mmproj: false }))).toBe(false);
    expect(recipeIsEmpty(recipe({ engine: { type: 'builtin', kind: 'vllm-docker' } }))).toBe(false);
    expect(recipeIsEmpty(recipe({ args: { sglang: ['--x'] } }))).toBe(false);
    expect(recipeIsEmpty(recipe({ env: { A: '1' } }))).toBe(false);
  });

  it('ids are slugs of the name, made unique', () => {
    expect(recipeIdFor('Qwen3 8B — YaRN 300K', [])).toBe('qwen3-8b-yarn-300k');
    expect(recipeIdFor('Città', ['citta', 'citta-2'])).toBe('citta-3');
    expect(recipeIdFor('!!!', [])).toBe('recipe');
  });

  it('a request choice and an applied record have their defaults', () => {
    expect(recipeChoiceSchema.parse({})).toEqual({ use: true });
    expect(appliedRecipeSchema.parse({ id: 'r', name: 'R' })).toEqual({ id: 'r', name: 'R', from: [], parts: [], args: [], envNames: [], overridden: [], skipped: [] });
  });
});

describe('which recipe a model gets', () => {
  it('patterns: plain text in any case, or /regex/ (always case-insensitive, never global)', () => {
    expect(textMatcher('QWEN')?.('unsloth/qwen3')).toBe(true);
    const re = textMatcher('/^qwen3-(8|14)b/gy');
    expect(re?.('Qwen3-8B')).toBe(true);
    // Not global: the same text matches every time.
    expect(re?.('Qwen3-8B')).toBe(true);
    expect(re?.('Qwen3-32B')).toBe(false);
    expect(textMatcher('/(/')).toBeUndefined();
  });

  it('an exact entry: a known sha256 on both sides decides alone', () => {
    expect(modelEntryRank({ label: 'x', sha256: SHA.toUpperCase() }, qwen)).toBe(4);
    expect(modelEntryRank({ label: 'x', sha256: 'b'.repeat(64), weakKey: qwen.weakKey }, qwen)).toBe(0);
    // The model is not hashed yet: its weak key.
    expect(modelEntryRank({ label: 'x', sha256: SHA, weakKey: qwen.weakKey }, { ...qwen, sha256: undefined })).toBe(3);
  });

  it('an exact entry by repo: with its file (only the name counts), or every file of the repo', () => {
    expect(modelEntryRank({ label: 'x', repo: 'UNSLOTH/qwen3-8b-gguf', file: 'sub/qwen3-8b-q4_k_m.gguf' }, { ...qwen, sha256: undefined })).toBe(3);
    expect(modelEntryRank({ label: 'x', repo: 'unsloth/Qwen3-8B-GGUF' }, { ...qwen, sha256: undefined })).toBe(2);
    expect(modelEntryRank({ label: 'x', repo: 'unsloth/Qwen3-8B-GGUF', file: 'other.gguf' }, { ...qwen, sha256: undefined })).toBe(0);
    expect(modelEntryRank({ label: 'x', repo: 'unsloth/Qwen3-8B-GGUF', file: 'x.gguf' }, { displayName: 'x', repo: 'unsloth/Qwen3-8B-GGUF' })).toBe(0);
    expect(modelEntryRank({ label: 'x', repo: 'other/repo' }, qwen)).toBe(0);
    expect(modelEntryRank({ label: 'x', repo: 'r' }, { displayName: 'local file' })).toBe(0);
    expect(modelEntryRank({ label: 'x', weakKey: 'k' }, { displayName: 'no key' })).toBe(0);
  });

  it('a pattern: name over repo, file and name; quant as a whole token of the quant or file name', () => {
    expect(recipeRank({ models: [], name: 'qwen3' }, qwen)).toBe(5);
    expect(recipeRank({ models: [], name: 'qwen3', quant: 'q4_k_m' }, qwen)).toBe(10);
    expect(recipeRank({ models: [], quant: 'Q4_K' }, qwen)).toBe(0);
    expect(recipeRank({ models: [], quant: '/^q4/' }, qwen)).toBe(5);
    expect(recipeRank({ models: [], name: 'llama' }, qwen)).toBe(0);
    expect(recipeRank({ models: [] }, qwen)).toBe(0);
    // The quant only in the file name; a model with no repo or file is matched on its name.
    expect(recipeRank({ models: [], quant: 'PQ2_0' }, { displayName: 'Bonsai', file: 'C:\\m\\Bonsai-8B-PQ2_0.gguf' })).toBe(5);
    expect(recipeRank({ models: [], quant: 'PQ2_0' }, { displayName: 'Bonsai' })).toBe(0);
    expect(recipeRank({ models: [], name: 'bonsai' }, { displayName: 'Bonsai 8B' })).toBe(5);
  });

  it('exact beats any pattern; between patterns the more specific; then the list order', () => {
    const family = recipe({ id: 'family', match: { models: [], name: 'qwen3' } });
    const quant = recipe({ id: 'quant', match: { models: [], name: 'qwen3', quant: 'Q4_K_M' } });
    const mine = recipe({ id: 'mine', match: { models: [{ label: 'Qwen3 8B', sha256: SHA }] } });
    const repo = recipe({ id: 'repo', match: { models: [{ label: 'repo', repo: 'unsloth/Qwen3-8B-GGUF' }] } });
    expect(recipeForModel([family, quant, mine], qwen)?.id).toBe('mine');
    expect(recipeForModel([family, quant], qwen)?.id).toBe('quant');
    expect(recipeForModel([family, recipe({ id: 'family-2', match: { models: [], name: 'qwen' } })], qwen)?.id).toBe('family');
    expect(recipeForModel([repo, mine], qwen)?.id).toBe('mine');
    expect(recipeForModel([repo, family], qwen)?.id).toBe('repo');
    expect(recipeForModel([family], { displayName: 'Llama 3' })).toBeUndefined();
    expect(recipeIsExactFor(mine.match, qwen)).toBe(true);
    expect(recipeIsExactFor(family.match, qwen)).toBe(false);
    expect(recipeIsExactFor({ ...mine.match, quant: 'Q4_K_M' }, qwen)).toBe(false);
  });
});

describe('YaRN', () => {
  it('factor = target / trained context, from the trained context; nothing within it or past ×64', () => {
    expect(yarnScaling(307_200, 32_768)).toEqual({ type: 'yarn', factor: 9.375, originalContext: 32_768 });
    expect(yarnScaling(512_000, 40_960)).toEqual({ type: 'yarn', factor: 12.5, originalContext: 40_960 });
    // 6 decimals.
    expect(yarnScaling(307_200, 131_000)?.factor).toBe(2.345038);
    expect(yarnScaling(32_768, 32_768)).toBeUndefined();
    expect(yarnScaling(307_200, undefined)).toBeUndefined();
    expect(yarnScaling(307_200, 0)).toBeUndefined();
    expect(yarnScaling(4_194_304, 4096)).toBeUndefined();
  });

  it('the context a launch can use: trained, or factor × original', () => {
    expect(extendedContext(32_768, undefined)).toBe(32_768);
    expect(extendedContext(undefined, undefined)).toBeUndefined();
    expect(extendedContext(40_960, { type: 'yarn', factor: 4, originalContext: 32_768 })).toBe(131_072);
    expect(extendedContext(undefined, { type: 'linear', factor: 2, originalContext: 4096 })).toBe(8192);
    expect(extendedContext(262_144, { type: 'yarn', factor: 1.5, originalContext: 4096 })).toBe(262_144);
  });

  it('300K and 500K are offered; the first above the trained context is proposed', () => {
    expect(YARN_TARGETS).toEqual([307_200, 512_000]);
    expect(CONTEXT_200K).toBe(200 * 1024);
    expect(defaultYarnTarget(32_768)).toBe(307_200);
    expect(defaultYarnTarget(307_200)).toBe(512_000);
    expect(defaultYarnTarget(1_048_576)).toBe(2_097_152);
  });
});

describe('what a recipe adds to a launch', () => {
  const full = recipe({
    contextSize: 307_200,
    ropeScaling: { type: 'yarn', factor: 9.375, originalContext: 32_768 },
    draft: DRAFT_AUTO,
    mmproj: true,
    args: { llamacpp: ['--jinja'], vllm: ['--enable-chunked-prefill'], command: ['--fast'] },
    env: { GGML_CUDA_GRAPHS: '1' },
  });
  const aux = [
    { kind: 'mmproj' as const, path: 'C:\\m\\mmproj-F16.gguf' },
    { kind: 'mtp' as const, path: 'C:\\m\\mtp-Q8_0.gguf' },
  ];

  it('the engines that take its arguments', () => {
    expect(recipeArgTargetOf('llamacpp-docker')).toBe('llamacpp');
    expect(recipeArgTargetOf('vllm-native')).toBe('vllm');
    expect(recipeArgTargetOf('sglang-docker')).toBe('sglang');
    expect(recipeArgTargetOf('command')).toBe('command');
    expect(recipeArgTargetOf('ninfer-wsl')).toBe('ninfer');
    expect(recipeArgTargetOf('external')).toBeUndefined();
  });

  it('NInfer: the context (--max-context) and its own arguments; it runs its models as trained (no RoPE)', () => {
    const n = recipePatchFor(recipe({ contextSize: 65_536, ropeScaling: { type: 'yarn', factor: 2, originalContext: 32_768 }, args: { ninfer: ['--kv-dtype', 'int8'] } }), { kind: 'ninfer-native' });
    expect(n).toMatchObject({ params: { contextSize: 65_536 }, args: ['--kv-dtype', 'int8'], parts: ['context', 'args'], skipped: [{ part: 'rope', reason: 'engine' }] });
  });

  it('llama.cpp: context, RoPE, the MTP file next to the model, the projector, its arguments, env', () => {
    const p = recipePatchFor(full, { kind: 'llamacpp-native', auxiliary: aux });
    expect(p.params).toEqual({ contextSize: 307_200, ropeScaling: { type: 'yarn', factor: 9.375, originalContext: 32_768 } });
    expect(p.args).toEqual(['-md', 'C:\\m\\mtp-Q8_0.gguf', '--mmproj', 'C:\\m\\mmproj-F16.gguf', '--jinja']);
    expect(p.env).toEqual({ GGML_CUDA_GRAPHS: '1' });
    expect(p.parts).toEqual(['context', 'rope', 'draft', 'mmproj', 'args', 'env']);
    expect(p.skipped).toEqual([]);
    // The build says how to use the file (--spec-type draft-mtp…).
    const spec = recipePatchFor(full, { kind: 'llamacpp-native', auxiliary: aux, draftArgs: (f) => ['--spec-type', `draft-${f.kind}`, '-md', f.path] });
    expect(spec.args.slice(0, 4)).toEqual(['--spec-type', 'draft-mtp', '-md', 'C:\\m\\mtp-Q8_0.gguf']);
  });

  it('a draft file named in the recipe: MTP by its name, else a plain draft model', () => {
    const seen: string[] = [];
    const draftArgs = (f: { kind: string; path: string }) => (seen.push(f.kind), ['-md', f.path]);
    recipePatchFor(recipe({ draft: '/m/Qwen3-MTP-Q8.gguf' }), { kind: 'llamacpp-native', draftArgs });
    recipePatchFor(recipe({ draft: '/m/qwen3-0.6b.gguf' }), { kind: 'llamacpp-native', draftArgs });
    expect(seen).toEqual(['mtp', 'draft']);
  });

  it('vLLM and SGLang: the context as max-model-len, their own arguments; llama.cpp-only parts are said', () => {
    const v = recipePatchFor(full, { kind: 'vllm-docker', auxiliary: aux });
    expect(v.params).toEqual({ maxModelLen: 307_200, ropeScaling: full.ropeScaling });
    expect(v.args).toEqual(['--enable-chunked-prefill']);
    expect(v.skipped).toEqual([
      { part: 'draft', reason: 'engine' },
      { part: 'mmproj', reason: 'engine' },
    ]);
    // Arguments written only for other engines.
    const s = recipePatchFor(full, { kind: 'sglang-native' });
    expect(s.skipped).toContainEqual({ part: 'args', reason: 'engine' });
    expect(s.parts).toEqual(['context', 'rope', 'env']);
  });

  it('a command-template program: the context ({ctx}) and its own arguments, no RoPE flags', () => {
    const c = recipePatchFor(full, { kind: 'command' });
    expect(c.params).toEqual({ contextSize: 307_200 });
    expect(c.args).toEqual(['--fast']);
    expect(c.skipped).toContainEqual({ part: 'rope', reason: 'engine' });
  });

  it('missing files and builds that cannot use them are said, never guessed', () => {
    const none = recipePatchFor(full, { kind: 'llamacpp-native', auxiliary: [] });
    expect(none.skipped).toEqual([
      { part: 'draft', reason: 'no_file' },
      { part: 'mmproj', reason: 'no_file' },
    ]);
    const old = recipePatchFor(full, { kind: 'llamacpp-native', auxiliary: aux, draftArgs: () => undefined });
    expect(old.skipped).toEqual([{ part: 'draft', reason: 'engine' }]);
    expect(recipePatchFor(recipe(), { kind: 'llamacpp-native' })).toEqual({ params: {}, args: [], env: {}, parts: [], skipped: [] });
  });

  it('an external endpoint takes nothing of it', () => {
    const e = recipePatchFor({ ...full, mmproj: false }, { kind: 'external' });
    expect(e.args).toEqual([]);
    expect(e.skipped.map((s) => s.part)).toEqual(['context', 'rope', 'draft', 'args', 'env']);
    expect(partsOf({ ...full, engine: { type: 'template', template: 'prismml-bonsai' } })).toEqual(['engine', 'context', 'rope', 'draft', 'mmproj', 'args', 'env']);
    expect(partsOf(recipe({ args: { sglang: ['--x'] } }))).toEqual(['args']);
  });
});

describe('the user’s own settings win over the recipe', () => {
  const patch = recipePatchFor(recipe({ contextSize: 307_200, ropeScaling: { type: 'yarn', factor: 9.375, originalContext: 32_768 }, args: { llamacpp: ['--rope-scale', '9.375', '-md', '/m/mtp.gguf', '--jinja'] }, env: { A: '1', B: '2' } }), {
    kind: 'llamacpp-native',
  });

  it('nothing set by the user: the recipe’s values, its arguments first', () => {
    const { params, overridden } = mergeRecipeParams(P({ extraArgs: ['--mlock'] }), patch);
    expect(params).toMatchObject({ contextSize: 307_200, ropeScaling: { factor: 9.375 }, extraArgs: ['--rope-scale', '9.375', '-md', '/m/mtp.gguf', '--jinja', '--mlock'], env: { A: '1', B: '2' } });
    expect(overridden).toEqual([]);
  });

  it('the user’s context, RoPE scaling, flags (any spelling) and variables replace the recipe’s, and are listed', () => {
    const { params, overridden } = mergeRecipeParams(
      P({ contextSize: 8192, ropeScaling: { type: 'linear', factor: 2, originalContext: 4096 }, extraArgs: ['--model-draft', '/m/other.gguf', '--rope-scale=4'], env: { B: '3' } }),
      patch,
    );
    expect(params.contextSize).toBe(8192);
    expect(params.ropeScaling).toEqual({ type: 'linear', factor: 2, originalContext: 4096 });
    expect(params.extraArgs).toEqual(['--jinja', '--model-draft', '/m/other.gguf', '--rope-scale=4']);
    expect(params.env).toEqual({ A: '1', B: '3' });
    expect(overridden).toEqual(['context', 'rope', '--rope-scale', '-md', 'env:B']);
  });

  it('the same values (a rerun of a recipe run) are not "replaced" and not doubled', () => {
    const again = mergeRecipeParams(P({ contextSize: 307_200, ropeScaling: { type: 'yarn', factor: 9.375, originalContext: 32_768 }, extraArgs: ['-md', '/m/mtp.gguf'], env: { A: '1' } }), patch);
    expect(again.overridden).toEqual([]);
    expect(again.params.extraArgs).toEqual(['--rope-scale', '9.375', '--jinja', '-md', '/m/mtp.gguf']);
    // vLLM's max-model-len is the same setting as the context.
    const v = recipePatchFor(recipe({ contextSize: 65_536 }), { kind: 'vllm-docker' });
    expect(mergeRecipeParams(P(), v).params.maxModelLen).toBe(65_536);
    expect(mergeRecipeParams(P({ maxModelLen: 65_536 }), v).overridden).toEqual([]);
  });

  it('arguments as flag groups: a leading value stays with nothing', () => {
    expect(argGroups(['value', '--a', '1', '2', '-b'])).toEqual([['value'], ['--a', '1', '2'], ['-b']]);
    const lead = recipePatchFor(recipe({ args: { llamacpp: ['positional', '--x'] } }), { kind: 'llamacpp-native' });
    expect(mergeRecipeParams(P({ extraArgs: ['--x'] }), lead).params.extraArgs).toEqual(['positional', '--x']);
  });
});

describe('the preferred engine', () => {
  const engine = (over: Partial<CustomEngine> & Record<string, unknown>): CustomEngine =>
    customEngineSchema.parse({ id: 'prismml', name: 'Fork PrismML', base: 'llamacpp', run: { mode: 'native', path: '/p/llama-server' }, ...over });
  const bonsai: RecipeModelRef = { displayName: 'Bonsai 8B', file: 'Bonsai-8B-PQ2_0.gguf' };

  it('a saved engine by id; a built-in is the page’s choice, not a custom engine', () => {
    expect(recipeCustomEngine({ type: 'custom', id: 'prismml' }, [engine({})])?.id).toBe('prismml');
    expect(recipeCustomEngine({ type: 'custom', id: 'gone' }, [engine({})])).toBeUndefined();
    expect(recipeCustomEngine({ type: 'builtin', kind: 'vllm-docker' }, [engine({})])).toBeUndefined();
    expect(recipeCustomEngine(undefined, [engine({})])).toBeUndefined();
  });

  it('a template: the engine made from it, else (for its models) a saved engine whose rules match', () => {
    const made = engine({ template: 'prismml-bonsai' });
    expect(recipeCustomEngine({ type: 'template', template: 'prismml-bonsai' }, [engine({ id: 'x' }), made])).toBe(made);
    const byRules = engine({ id: 'mine', match: { names: ['bonsai'], quants: [] } });
    expect(recipeCustomEngine({ type: 'template', template: 'prismml-bonsai' }, [byRules], bonsai)).toBe(byRules);
    // Not a Bonsai model, or no model: only the engine made from the template counts.
    expect(recipeCustomEngine({ type: 'template', template: 'prismml-bonsai' }, [byRules], qwen)).toBeUndefined();
    expect(recipeCustomEngine({ type: 'template', template: 'prismml-bonsai' }, [byRules])).toBeUndefined();
    expect(recipeCustomEngine({ type: 'template', template: 'prismml-bonsai' }, [], bonsai)).toBeUndefined();
  });
});

describe('built-in recipes', () => {
  const gguf: RecipeTemplateModel = { ...qwen, format: 'gguf', trainedContext: 40_960, auxKinds: [] };
  const t = (id: string) => recipeTemplate(id)!;

  it('the library: YaRN, MTP, PrismML for Bonsai, images; each says what it sets and where it is documented', () => {
    expect(RECIPE_TEMPLATES.map((x) => x.id)).toEqual(['yarn', 'mtp', 'prismml-bonsai', 'vision', 'ninfer']);
    expect(RECIPE_TEMPLATES.every((x) => x.parts.length > 0 && x.docs.every((d) => d.startsWith('https://')))).toBe(true);
    expect(recipeTemplate('nope')).toBeUndefined();
  });

  it('YaRN: needs the trained context; 300K by default, any target asked', () => {
    expect(t('yarn').blocked({ ...gguf, trainedContext: undefined })).toBe('no_context');
    expect(t('yarn').blocked(gguf)).toBeUndefined();
    expect(t('yarn').build(gguf)).toEqual({ contextSize: 307_200, ropeScaling: { type: 'yarn', factor: 7.5, originalContext: 40_960 } });
    expect(t('yarn').build(gguf, { yarnTarget: 512_000 })).toMatchObject({ contextSize: 512_000, ropeScaling: { factor: 12.5 } });
    // A target within the trained context sets nothing.
    expect(t('yarn').build(gguf, { yarnTarget: 32_768 })).toEqual({});
  });

  it('MTP: a GGUF needs its MTP or draft file; vLLM and SGLang get their documented flags', () => {
    expect(t('mtp').blocked(gguf)).toBe('no_file');
    expect(t('mtp').blocked({ ...gguf, auxKinds: ['mtp'] })).toBeUndefined();
    expect(t('mtp').blocked({ ...gguf, format: 'safetensors' })).toBeUndefined();
    expect(t('mtp').build(gguf)).toEqual({ draft: DRAFT_AUTO, args: { vllm: [...VLLM_MTP_ARGS], sglang: [...SGLANG_MTP_ARGS] } });
    expect(JSON.parse(VLLM_MTP_ARGS[1])).toEqual({ method: 'mtp', num_speculative_tokens: 1 });
  });

  it('NInfer: offered for .ninfer artifacts only, it picks the NInfer engine; the others are not for them', () => {
    const art: RecipeTemplateModel = { displayName: 'Qwen3.8 27B', format: 'ninfer', trainedContext: 262_144, auxKinds: ['mtp', 'mmproj'] };
    expect(t('ninfer').blocked(art)).toBeUndefined();
    expect(t('ninfer').blocked(gguf)).toBe('format');
    expect(t('ninfer').build(art)).toEqual({ engine: { type: 'builtin', kind: 'ninfer-native' } });
    expect(['yarn', 'mtp', 'vision'].map((id) => t(id).blocked(art))).toEqual(['format', 'format', 'format']);
  });

  it('PrismML: only for Bonsai models; images: GGUF with a projector', () => {
    expect(t('prismml-bonsai').blocked(gguf)).toBe('not_bonsai');
    expect(t('prismml-bonsai').blocked({ displayName: 'Bonsai 8B', quant: 'PQ2_0' })).toBeUndefined();
    expect(t('prismml-bonsai').build(gguf)).toEqual({ engine: { type: 'template', template: 'prismml-bonsai' } });
    expect(t('vision').blocked({ ...gguf, format: 'safetensors' })).toBe('format');
    expect(t('vision').blocked(gguf)).toBe('no_file');
    expect(t('vision').blocked({ ...gguf, auxKinds: ['mmproj'] })).toBeUndefined();
    expect(t('vision').build(gguf)).toEqual({ mmproj: true });
    // Nothing known about its files (a run's model): no file.
    expect(t('vision').blocked({ displayName: 'x', format: 'gguf' })).toBe('no_file');
  });

  it('"Usa" adds a built-in’s settings to the model’s recipe: its flags replace the same flags, the rest stays', () => {
    const mine = recipe({ contextSize: 65_536, args: { vllm: ['--speculative-config', '{}', '--enforce-eager'], llamacpp: ['--jinja'] }, from: ['yarn'] });
    const both = withTemplate(mine, t('mtp'), gguf);
    expect(both.args).toEqual({ llamacpp: ['--jinja'], vllm: ['--enforce-eager', ...VLLM_MTP_ARGS], sglang: [...SGLANG_MTP_ARGS] });
    expect(both).toMatchObject({ contextSize: 65_536, draft: DRAFT_AUTO, from: ['yarn', 'mtp'] });
    const again = withTemplate(both, t('yarn'), gguf, { yarnTarget: 512_000 });
    expect(again).toMatchObject({ contextSize: 512_000, from: ['yarn', 'mtp'], args: both.args });
  });
});
