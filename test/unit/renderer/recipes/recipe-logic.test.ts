/** "Comandi per questo modello" in the renderer, the pure part: targets, words, the editor's form. */
import { describe, expect, it } from 'vitest';
import { customEngineSchema } from '../../../../src/contract/custom-engines';
import type { LocalModel } from '../../../../src/contract/models';
import { modelRecipeSchema, type AppliedRecipe, type ModelRecipe } from '../../../../src/contract/recipes';
import type { CuratedModel } from '../../../../src/contract/views';
import type { ModelOption } from '../../../../src/renderer/components/bench/model-options';
import { engineOfValue, engineValue, formOfRecipe, recipeOfForm, showArg, type RecipeForm } from '../../../../src/renderer/components/recipes/recipe-form';
import {
  appliedLines,
  previewEngines,
  recipeParts,
  scopeText,
  targetOfHub,
  targetOfLocal,
  targetOfOption,
  templateEngineLink,
  templateEngineName,
} from '../../../../src/renderer/components/recipes/recipe-model';
import { createFormatters } from '../../../../src/renderer/i18n';
import { EMPTY_PARAMS_FORM, formFromParams, paramsFromForm } from '../../../../src/renderer/components/bench/expert-form';
import { noteText } from '../../../../src/renderer/components/bench/notes';
import { configParts } from '../../../../src/renderer/components/bench/summary';
import { launchParamsSchema } from '../../../../src/contract/engines';

const f = createFormatters('it');
const SHA = 'c'.repeat(64);

function local(over: Partial<LocalModel['identity']> = {}, aux: LocalModel['auxiliary'] = []): LocalModel {
  return {
    id: 'm1',
    identity: { displayName: 'Qwen3-8B-Q4_K_M', format: 'gguf', source: 'local', file: 'Qwen3-8B-Q4_K_M.gguf', files: [], quant: 'Q4_K_M', weakKey: 'local/Qwen3-8B-Q4_K_M.gguf/Q4_K_M/5', facts: { contextLength: 40_960 }, ...over },
    paths: ['C:/m/Qwen3-8B-Q4_K_M.gguf'],
    auxiliary: aux,
    dir: 'C:/m',
    origin: 'library',
    modifiedAt: '',
  };
}
const recipe = (over: Record<string, unknown> = {}): ModelRecipe => modelRecipeSchema.parse({ id: 'r', name: 'R', match: { models: [{ label: 'x', weakKey: 'w' }] }, ...over });

describe('recipe targets', () => {
  it('a local model: its identity, its trained context and files, the quant said once', () => {
    const t = targetOfLocal(local({ sha256: SHA, repo: 'unsloth/Qwen3-8B-GGUF' }, [{ kind: 'mtp', path: 'C:/m/mtp.gguf' }]));
    expect(t).toMatchObject({
      label: 'Qwen3-8B-Q4_K_M',
      ref: { repo: 'unsloth/Qwen3-8B-GGUF', sha256: SHA, weakKey: 'local/Qwen3-8B-Q4_K_M.gguf/Q4_K_M/5' },
      template: { format: 'gguf', trainedContext: 40_960, auxKinds: ['mtp'] },
      entry: { label: 'Qwen3-8B-Q4_K_M', sha256: SHA, repo: 'unsloth/Qwen3-8B-GGUF', file: 'Qwen3-8B-Q4_K_M.gguf' },
      request: { localId: 'm1' },
      engines: ['llamacpp-native'],
    });
    // A name without the quant gets it; no repo: no repo entry.
    const plain = targetOfLocal(local(), 'Qwen3 8B');
    expect(plain.entry).toEqual({ label: 'Qwen3 8B · Q4_K_M', weakKey: 'local/Qwen3-8B-Q4_K_M.gguf/Q4_K_M/5' });
    expect(targetOfLocal(local({ quant: undefined }), 'X').entry.label).toBe('X');
  });

  it('a suggestion to download (GGUF or a vLLM repo) and a library model as Benchmark options', () => {
    const c = { id: 'q', label: 'Qwen3 4B · Q4_K_M', engine: 'llamacpp', tier: 8, repo: 'Qwen/Qwen3-4B-GGUF', file: 'Qwen3-4B-Q4_K_M.gguf', revision: 'r1', sizeBytes: 1, quant: 'Q4_K_M', paramsB: 4, license: 'x', sha256: SHA } as CuratedModel;
    const gguf = targetOfOption({ key: 'curated:q', source: 'curated', name: 'Qwen3 4B', quant: 'Q4_K_M', sizeBytes: 1, paramsB: 4, curated: c });
    expect(gguf).toMatchObject({ entry: { label: 'Qwen3 4B · Q4_K_M', repo: 'Qwen/Qwen3-4B-GGUF', file: 'Qwen3-4B-Q4_K_M.gguf', sha256: SHA }, request: { repo: 'Qwen/Qwen3-4B-GGUF', file: 'Qwen3-4B-Q4_K_M.gguf', revision: 'r1' }, template: { format: 'gguf' } });
    const st = targetOfOption({ key: 'curated:v', source: 'curated', name: 'Qwen3 4B AWQ', quant: 'AWQ', sizeBytes: 1, paramsB: 4, curated: { ...c, engine: 'vllm', file: undefined, sha256: undefined } as unknown as CuratedModel });
    expect(st).toMatchObject({ ref: { weakKey: 'Qwen/Qwen3-4B-GGUF@r1' }, request: { repo: 'Qwen/Qwen3-4B-GGUF', revision: 'r1' }, engines: ['vllm-docker', 'sglang-docker'] });
    expect(st.entry).toEqual({ label: 'Qwen3 4B AWQ · Q4_K_M', repo: 'Qwen/Qwen3-4B-GGUF' });
    const mine: ModelOption = { key: 'local:m1', source: 'local', name: 'Qwen3 8B', local: local() };
    expect(targetOfOption(mine).label).toBe('Qwen3 8B');
  });

  it('a hub repo: every file of it; a GGUF preview starts the chosen quant', () => {
    expect(targetOfHub({ repo: 'org/Model-GGUF', file: 'Q4/Model-Q4_K_M-00001-of-00002.gguf', quant: 'Q4_K_M', format: 'gguf', trainedContext: 131_072, auxKinds: ['mmproj'] })).toMatchObject({
      label: 'Model-GGUF',
      entry: { label: 'Model-GGUF', repo: 'org/Model-GGUF' },
      request: { repo: 'org/Model-GGUF', file: 'Q4/Model-Q4_K_M-00001-of-00002.gguf' },
      template: { trainedContext: 131_072, auxKinds: ['mmproj'] },
    });
    expect(targetOfHub({ repo: 'org/Model', format: 'safetensors' })).toMatchObject({ request: { repo: 'org/Model' }, template: { auxKinds: [] } });
    expect(previewEngines('ninfer')).toEqual(['ninfer-native']);
    expect(previewEngines(undefined)).toEqual(['llamacpp-native']);
  });
});

describe('a recipe in words', () => {
  const engines = [customEngineSchema.parse({ id: 'prismml', name: 'Fork PrismML', base: 'llamacpp', run: { mode: 'native', path: '/p' }, template: 'prismml-bonsai' })];
  const ctx = { customEngines: engines };

  it('YaRN with its context, MTP, images, arguments and variables', () => {
    const r = recipe({ contextSize: 307_200, ropeScaling: { type: 'yarn', factor: 7.5, originalContext: 40_960 }, draft: 'auto', mmproj: true, args: { llamacpp: ['--jinja', '-x'], vllm: ['--y'] }, env: { A: '1' } });
    expect(recipeParts(r, f, ctx)).toEqual(['YaRN 300K', 'MTP', 'Immagini', '3 argomenti', '1 variabile']);
    expect(recipeParts(recipe({ args: { llamacpp: ['--jinja'] }, env: { A: '1', B: '2' } }), f, ctx)).toEqual(['1 argomento', '2 variabili']);
  });

  it('RoPE without a context, linear scaling, a fixed context, a draft model', () => {
    expect(recipeParts(recipe({ ropeScaling: { type: 'yarn', factor: 4, originalContext: 32_768 } }), f, ctx)).toEqual(['YaRN ×4,00']);
    expect(recipeParts(recipe({ ropeScaling: { type: 'linear', factor: 2, originalContext: 4096 }, contextSize: 8192 }), f, ctx)).toEqual(['RoPE lineare ×2,00']);
    expect(recipeParts(recipe({ ropeScaling: { type: 'linear', factor: 2, originalContext: 4096 } }), f, ctx)).toEqual(['RoPE lineare ×2,00']);
    expect(recipeParts(recipe({ contextSize: 65_536 }), f, ctx)).toEqual(['Contesto 64K']);
    // "auto" with a plain draft file next to the model; a named file: MTP by its name.
    expect(recipeParts(recipe({ draft: 'auto' }), f, { ...ctx, aux: [{ kind: 'draft', path: '/m/d.gguf' }] })).toEqual(['Modello draft']);
    expect(recipeParts(recipe({ draft: '/m/Qwen3-MTP.gguf' }), f, ctx)).toEqual(['MTP']);
    expect(recipeParts(recipe({ draft: '/m/small.gguf' }), f, ctx)).toEqual(['Modello draft']);
  });

  it('the engine: a built-in, a saved custom engine, one still to set up', () => {
    expect(recipeParts(recipe({ engine: { type: 'builtin', kind: 'ninfer-wsl' } }), f, ctx)).toEqual(['NInfer (WSL)']);
    expect(recipeParts(recipe({ engine: { type: 'template', template: 'prismml-bonsai' } }), f, ctx)).toEqual(['Fork PrismML']);
    expect(recipeParts(recipe({ engine: { type: 'template', template: 'prismml-bonsai' } }), f, { customEngines: [] })).toEqual(['Fork PrismML (da indicare)']);
    expect(recipeParts(recipe({ engine: { type: 'custom', id: 'gone' } }), f, ctx)).toEqual(['gone (da indicare)']);
    expect(templateEngineName('other', f)).toBe('other');
  });

  it('who it is for', () => {
    expect(scopeText(recipe(), f)).toBe('Solo per questo modello');
    expect(scopeText(recipe({ match: { models: [{ label: 'a', weakKey: 'a' }, { label: 'b', weakKey: 'b' }] } }), f)).toBe('Per 2 modelli scelti');
    expect(scopeText(recipe({ match: { name: 'qwen3' } }), f)).toBe('Per tutti i modelli che contengono «qwen3»');
    expect(scopeText(recipe({ match: { quant: 'Q4_K_M' } }), f)).toBe('Per tutti i modelli in Q4_K_M');
    expect(scopeText(recipe({ match: { name: 'qwen3', quant: 'Q4_K_M' } }), f)).toBe('Per i modelli «qwen3» in Q4_K_M');
  });

  it('what a run applied: its parts, what the user replaced, what did not apply', () => {
    const a: AppliedRecipe = {
      id: 'r',
      name: 'Qwen3 · YaRN',
      from: [],
      parts: ['engine', 'context', 'rope', 'draft', 'args'],
      args: [],
      envNames: [],
      contextSize: 307_200,
      ropeScaling: { type: 'yarn', factor: 7.5, originalContext: 40_960 },
      engine: { customEngineId: 'prismml', name: 'Fork PrismML' },
      overridden: ['context', '--jinja', 'env:A'],
      skipped: [
        { part: 'mmproj', reason: 'no_file' },
        { part: 'rope', reason: 'user' },
      ],
    };
    expect(appliedLines(a, f)).toEqual({
      line: 'Usa i comandi «Qwen3 · YaRN»: Fork PrismML · YaRN 300K · MTP · argomenti',
      overridden: 'Sostituiti dai tuoi valori: contesto, --jinja, A',
      skipped: 'Non usati qui: immagini (file mancante)',
    });
    expect(appliedLines({ ...a, engine: { kind: 'ninfer-wsl', name: 'ninfer-wsl' }, contextSize: undefined, overridden: [], skipped: [] }, f).line).toBe('Usa i comandi «Qwen3 · YaRN»: NInfer (WSL) · YaRN ×7,50 · MTP · argomenti');
    expect(appliedLines({ ...a, engine: undefined, ropeScaling: undefined, parts: ['context'], overridden: [], skipped: [] }, f).line).toBe('Usa i comandi «Qwen3 · YaRN»: Contesto 300K');
    expect(appliedLines({ ...a, engine: undefined, ropeScaling: undefined, contextSize: undefined, parts: [], overridden: [], skipped: [] }, f)).toEqual({ line: 'Usa i comandi «Qwen3 · YaRN»' });
  });

  it('the guided action: the Engines page dialog for the template, for this model', () => {
    expect(templateEngineLink('prismml-bonsai', { label: 'Bonsai 8B', ref: { displayName: 'Bonsai', weakKey: 'w/k' } })).toBe('/engines?customTemplate=prismml-bonsai&model=w%2Fk&modelName=Bonsai+8B');
    expect(templateEngineLink('prismml-bonsai', { label: 'Bonsai', ref: { displayName: 'Bonsai' } })).toBe('/engines?customTemplate=prismml-bonsai&modelName=Bonsai');
  });
});

describe('YaRN in expert mode and in labels', () => {
  const yarn = (over: Partial<typeof EMPTY_PARAMS_FORM>, trainedContext?: number) => paramsFromForm({ ...EMPTY_PARAMS_FORM, ...over }, { trainedContext });

  it('the form: target and trained context (typed, else the model\u2019s), or why not', () => {
    expect(yarn({ yarnTarget: '307200' }, 40_960)).toEqual({ params: expect.objectContaining({ contextSize: 307_200, maxModelLen: 307_200, ropeScaling: { type: 'yarn', factor: 7.5, originalContext: 40_960 } }), invalid: [] });
    expect(yarn({ yarnTarget: '307200', yarnOriginal: '32768' }, 40_960).params.ropeScaling?.originalContext).toBe(32_768);
    expect(yarn({ yarnTarget: '307200' }).invalid).toEqual(['yarnTarget']);
    expect(yarn({ yarnTarget: 'abc' }, 40_960).invalid).toEqual(['yarnTarget']);
    expect(yarn({ yarnTarget: '307200', yarnOriginal: 'x' }, 40_960).invalid).toEqual(['yarnTarget']);
  });

  it('a YaRN launch read back into the form: its context from either field, or factor \u00d7 original', () => {
    const rope = { type: 'yarn' as const, factor: 4, originalContext: 32_768 };
    expect(formFromParams(launchParamsSchema.parse({ maxModelLen: 131_072, ropeScaling: rope }))).toMatchObject({ yarnTarget: '131072', yarnOriginal: '32768', maxModelLen: '', contextSize: '' });
    expect(formFromParams(launchParamsSchema.parse({ ropeScaling: rope }))).toMatchObject({ yarnTarget: '131072' });
    expect(formFromParams(launchParamsSchema.parse({ contextSize: 8192, ropeScaling: { ...rope, type: 'linear' } }))).toMatchObject({ yarnTarget: '', contextSize: '8192' });
  });

  it('configurations say the RoPE scaling: YaRN with its original context, a bare factor, linear', () => {
    const parts = (ropeScaling: { type: string; factor?: number; originalContext?: number }) => configParts('llamacpp-native', { ropeScaling, other: [] }, f);
    expect(parts({ type: 'yarn', factor: 7.5, originalContext: 40_960 })).toContain('YaRN ×7,50 (da 40.960)');
    expect(parts({ type: 'yarn', factor: 4 })).toContain('YaRN ×4,00');
    expect(parts({ type: 'linear', factor: 2 })).toContain('RoPE lineare ×2,00');
    expect(parts({ type: 'yarn' }).join(' ')).not.toContain('YaRN');
  });

  it('the plan\u2019s notes keep the factor\u2019s decimals and say which file is missing', () => {
    expect(noteText({ code: 'context_beyond_trained', params: { contextSize: 307_200, trained: 40_960, factor: 7.5 } }, f)).toMatchObject({ tone: 'warning', title: 'Oltre il contesto di addestramento' });
    expect(noteText({ code: 'recipe_file_missing', params: { part: 'mmproj', recipe: 'R' } }, f).title).toBe('Manca il proiettore immagini');
    expect(noteText({ code: 'recipe_file_missing', params: { part: 'draft', recipe: 'R' } }, f).title).toBe('Manca il file MTP o draft');
  });
});

describe('the editor’s form', () => {
  const target = targetOfLocal(local(), 'Qwen3 8B');
  const form = (over: Partial<RecipeForm> = {}): RecipeForm => ({ ...formOfRecipe(undefined, target), ...over });

  it('a new recipe: the model’s name, this model only, nothing set; it saves as an empty recipe for this model', () => {
    const empty = form();
    expect(empty).toMatchObject({ name: 'Qwen3 8B', scope: 'model', context: 'auto', yarnTarget: '307200', yarnOriginal: '40960', draft: 'none', engine: 'default', mmproj: false });
    expect(recipeOfForm(empty, target)).toEqual({ draft: { name: 'Qwen3 8B', match: { models: [target.entry] }, args: {}, env: {}, notes: '', from: [] }, invalid: [] });
  });

  it('round trip of every part', () => {
    const r = recipe({
      name: 'Tutto',
      match: { models: [target.entry] },
      contextSize: 307_200,
      ropeScaling: { type: 'yarn', factor: 7.5, originalContext: 40_960 },
      draft: '/m/My MTP.gguf',
      mmproj: true,
      engine: { type: 'custom', id: 'prismml' },
      args: { llamacpp: ['--chat-template', 'a b'], sglang: ['--x'] },
      env: { A: '1' },
      notes: 'n',
      link: 'https://huggingface.co/x',
      from: ['yarn'],
    });
    const f1 = formOfRecipe(r, target);
    expect(f1).toMatchObject({ context: 'yarn', yarnTarget: '307200', draft: 'file', draftFile: '/m/My MTP.gguf', engine: 'custom:prismml', args: { llamacpp: '--chat-template "a b"', sglang: '--x', vllm: '' }, env: 'A=1' });
    const { draft } = recipeOfForm(f1, target);
    expect(draft).toEqual({ name: 'Tutto', match: r.match, contextSize: 307_200, ropeScaling: r.ropeScaling, draft: '/m/My MTP.gguf', mmproj: true, engine: r.engine, args: r.args, env: r.env, notes: 'n', link: 'https://huggingface.co/x', from: ['yarn'] });
    // A YaRN recipe without its context: the target is factor × original.
    expect(formOfRecipe(recipe({ ropeScaling: { type: 'yarn', factor: 4, originalContext: 32_768 } }), target).yarnTarget).toBe('131072');
    expect(formOfRecipe(recipe({ draft: 'auto' }), target).draft).toBe('auto');
    expect(formOfRecipe(recipe({ contextSize: 65_536 }), target)).toMatchObject({ context: 'fixed', contextSize: '65536' });
    expect(formOfRecipe(recipe({ match: { quant: 'Q8_0' } }), target)).toMatchObject({ scope: 'pattern', pattern: '', quant: 'Q8_0' });
  });

  it('arguments go back into the box so that they read the same again (JSON, spaces, apostrophes)', () => {
    expect(showArg('{"method":"mtp","num_speculative_tokens":1}')).toBe('\'{"method":"mtp","num_speculative_tokens":1}\'');
    expect(showArg('a b')).toBe('"a b"');
    expect(showArg("it's")).toBe('"it\'s"');
    expect(showArg('plain')).toBe('plain');
    expect(showArg('both " and \'')).toBe('both " and \'');
    const args = ['--speculative-config', '{"method":"mtp","num_speculative_tokens":1}', '--chat-template', 'a b'];
    const back = recipeOfForm(formOfRecipe(recipe({ args: { vllm: args } }), target), target).draft?.args?.vllm;
    expect(back).toEqual(args);
  });

  it('"this model" keeps the recipe’s own models when they include it, else this one alone; a pattern names no model', () => {
    const others = [{ label: 'a', weakKey: 'a' }, target.entry];
    expect(recipeOfForm(form({ models: others }), target).draft?.match).toEqual({ models: others });
    expect(recipeOfForm(form({ models: [{ label: 'a', weakKey: 'a' }] }), target).draft?.match).toEqual({ models: [target.entry] });
    expect(recipeOfForm(form({ scope: 'pattern', pattern: ' qwen3 ', quant: 'Q4_K_M' }), target).draft?.match).toEqual({ models: [], name: 'qwen3', quant: 'Q4_K_M' });
    expect(recipeOfForm(form({ scope: 'pattern', pattern: '', quant: 'Q4_K_M' }), target).draft?.match).toEqual({ models: [], quant: 'Q4_K_M' });
  });

  it('a fixed context, the MTP file next to the model, a built-in or template engine', () => {
    expect(recipeOfForm(form({ context: 'fixed', contextSize: '65.536', draft: 'auto', engine: 'builtin:llamacpp-docker' }), target).draft).toMatchObject({ contextSize: 65_536, draft: 'auto', engine: { type: 'builtin', kind: 'llamacpp-docker' } });
    expect(recipeOfForm(form({ engine: 'template:prismml-bonsai' }), target).draft?.engine).toEqual({ type: 'template', template: 'prismml-bonsai' });
    expect(engineValue({ type: 'template', template: 't' })).toBe('template:t');
    expect(engineValue({ type: 'builtin', kind: 'vllm-docker' })).toBe('builtin:vllm-docker');
    // A model whose trained context is unknown: YaRN starts with no original context.
    expect(formOfRecipe(undefined, { ...target, template: { ...target.template, trainedContext: undefined } }).yarnOriginal).toBe('');
    expect(engineOfValue('nonsense:x')).toBeUndefined();
  });

  it('every field that is not valid is said, and nothing is saved', () => {
    const bad = recipeOfForm(
      form({
        name: ' ',
        scope: 'pattern',
        pattern: '/(/',
        context: 'yarn',
        yarnTarget: '1000',
        yarnOriginal: 'x',
        draft: 'file',
        draftFile: ' ',
        args: { llamacpp: '"open', vllm: '', sglang: '', ninfer: '', command: '' },
        env: 'not a variable',
        link: 'ftp://x',
      }),
      target,
    );
    expect(bad).toEqual({ invalid: ['name', 'pattern', 'yarnOriginal', 'yarnTarget', 'draftFile', 'args.llamacpp', 'env', 'link'] });
    expect(recipeOfForm(form({ scope: 'pattern', pattern: '', quant: '' }), target).invalid).toEqual(['pattern']);
    expect(recipeOfForm(form({ scope: 'pattern', pattern: 'ok', quant: '/[/' }), target).invalid).toEqual(['pattern']);
    expect(recipeOfForm(form({ context: 'yarn', yarnTarget: '16384' }), target).invalid).toEqual(['yarnTarget']);
    expect(recipeOfForm(form({ context: 'fixed', contextSize: '100' }), target).invalid).toEqual(['contextSize']);
    expect(recipeOfForm(form({ link: 'not a url' }), target).invalid).toEqual(['link']);
  });

  it('what only the schema refuses is said on its field (lengths)', () => {
    const long = (n: number) => 'x'.repeat(n);
    expect(recipeOfForm(form({ name: long(81) }), target).invalid).toEqual(['name']);
    expect(recipeOfForm(form({ scope: 'pattern', pattern: long(201) }), target).invalid).toEqual(['pattern']);
    expect(recipeOfForm(form({ notes: long(4001) }), target).invalid).toEqual(['notes']);
    expect(recipeOfForm(form({ env: `A=${long(4001)}` }), target).invalid).toEqual(['env']);
    expect(recipeOfForm(form({ draft: 'file', draftFile: long(1001) }), target).invalid).toEqual(['draftFile']);
    expect(recipeOfForm(form({ link: `https://x.y/${long(2001)}` }), target).invalid).toEqual(['link']);
    expect(recipeOfForm(form({ args: { llamacpp: '', vllm: long(4001), sglang: '', ninfer: '', command: '' } }), target).invalid).toEqual(['args.vllm']);
  });
});
