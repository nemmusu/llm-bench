/**
 * "Comandi per questo modello" in the core: the recipe a run, a tune or a server uses, the engine it
 * chooses, what it sets and what the user's settings replaced; YaRN beyond the trained context.
 */
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import type { StartServerRequest } from '../../../../src/contract/api';
import { customEngineSchema, type CustomEngine } from '../../../../src/contract/custom-engines';
import { launchParamsSchema, type LaunchParams } from '../../../../src/contract/engines';
import { modelRecipeDraftSchema, modelRecipeSchema, type ModelRecipe } from '../../../../src/contract/recipes';
import { fileURLToPath } from 'node:url';
import { fileExists, recipeRefOf, recipeWarnings, withRecipe, type RecipeSources } from '../../../../src/core/bench/recipes';
import { buildScenario, sweepWithoutBudget } from '../../../../src/core/bench/scenarios';
import { BenchService, beyondTrained } from '../../../../src/core/bench/service';
import { buildTuneSetup, yarnSpace, type TunePrepared } from '../../../../src/core/bench/tune-setup';
import { FORECAST_ONLY } from '../../../../src/core/bench/tune-run';
import { Tuner, type Capacity } from '../../../../src/core/bench/tuner';
import { input } from './tune-lab';
import { capsFromOutputs, type LlamaCaps } from '../../../../src/core/engines/llamacpp-native/caps';
import type { EngineAdapter, ModelTarget } from '../../../../src/core/engines/types';
import { hardware, modelIdentity } from '../store/fixtures';
import { request, serviceSetup, TempDirs } from './service-helpers';

const HELP = readFileSync(new URL('../../../fixtures/llamacpp/help.stdout.txt', import.meta.url), 'utf8');
const CAPS = capsFromOutputs('', HELP) as LlamaCaps;
const tmp = new TempDirs();
afterEach(() => tmp.cleanup());

const P = (o: Partial<LaunchParams> = {}): LaunchParams => launchParamsSchema.parse(o);
const FACTS = { contextLength: 32_768, blockCount: 36 };
const ID = modelIdentity({ facts: FACTS });
const YARN = { type: 'yarn' as const, factor: 9.375, originalContext: 32_768 };
const local: ModelTarget = {
  identity: ID,
  local: {
    id: 'm1',
    identity: ID,
    paths: ['C:/m/Qwen3-4B-Q4_K_M.gguf', 'C:/m/mtp-Qwen3-4B.gguf', 'C:/m/mmproj.gguf'],
    auxiliary: [
      { kind: 'mtp', path: 'C:/m/mtp-Qwen3-4B.gguf' },
      { kind: 'mmproj', path: 'C:/m/mmproj.gguf' },
    ],
    dir: 'C:/m',
    origin: 'library',
    modifiedAt: '',
  },
};
const recipe = (over: Record<string, unknown> = {}): ModelRecipe =>
  modelRecipeSchema.parse({ id: 'qwen-yarn', name: 'Qwen3 4B YaRN', match: { models: [{ label: 'Qwen3 4B', weakKey: ID.weakKey }] }, contextSize: 307_200, ropeScaling: YARN, ...over });
const fork = (over: Record<string, unknown> = {}): CustomEngine =>
  customEngineSchema.parse({ id: 'prismml', name: 'Fork PrismML', base: 'llamacpp', run: { mode: 'native', path: '/p/llama-server' }, template: 'prismml-bonsai', ...over });
const sources = (recipes: ModelRecipe[], customEngines: CustomEngine[] = []): RecipeSources => ({ recipes, customEngines });
const req = (over: Partial<StartServerRequest> = {}): StartServerRequest => ({ engine: { kind: 'llamacpp-native' }, model: { localId: 'm1' }, ...over });
const noCaps = async () => undefined;

describe('withRecipe', () => {
  it('no recipes, none that matches, or turned off: the request as it is', async () => {
    const asked = req({ params: P({ threads: 4 }) });
    expect(await withRecipe(asked, local, undefined, noCaps)).toEqual({ engine: asked.engine, params: asked.params });
    expect((await withRecipe(req(), local, sources([recipe({ match: { name: 'llama' } })]), noCaps)).applied).toBeUndefined();
    expect((await withRecipe(req({ recipe: { use: false } }), local, sources([recipe()]), noCaps)).applied).toBeUndefined();
    // A recipe asked by an id that is gone: none.
    expect((await withRecipe(req({ recipe: { use: true, id: 'gone' } }), local, sources([recipe()]), noCaps)).applied).toBeUndefined();
  });

  it('the matching recipe: YaRN 300K, its MTP file with the build’s --spec-type, its projector, args and env', async () => {
    const r = recipe({ draft: 'auto', mmproj: true, args: { llamacpp: ['--jinja'] }, env: { GGML_X: '1' } });
    const w = await withRecipe(req({ params: P({ extraArgs: ['--mlock'] }) }), local, sources([r]), async () => CAPS);
    expect(w.params).toMatchObject({ contextSize: 307_200, ropeScaling: YARN, env: { GGML_X: '1' } });
    expect(w.params.extraArgs).toEqual(['--spec-type', 'draft-mtp', '-md', 'C:/m/mtp-Qwen3-4B.gguf', '-ngld', 'all', '--mmproj', 'C:/m/mmproj.gguf', '--jinja', '--mlock']);
    expect(w.applied).toEqual({
      id: 'qwen-yarn',
      name: 'Qwen3 4B YaRN',
      from: [],
      parts: ['context', 'rope', 'draft', 'mmproj', 'args', 'env'],
      args: ['--spec-type', 'draft-mtp', '-md', 'C:/m/mtp-Qwen3-4B.gguf', '-ngld', 'all', '--mmproj', 'C:/m/mmproj.gguf', '--jinja'],
      envNames: ['GGML_X'],
      contextSize: 307_200,
      ropeScaling: YARN,
      overridden: [],
      skipped: [],
    });
    // The build's options are unknown (a preview before the install): the plain draft flag; caps never asked without a draft.
    expect((await withRecipe(req(), local, sources([r]), async () => Promise.reject(new Error('not installed')))).params.extraArgs.slice(0, 2)).toEqual(['-md', 'C:/m/mtp-Qwen3-4B.gguf']);
    expect((await withRecipe(req(), local, sources([r]), async () => ({ ...CAPS, entries: undefined }) as unknown as LlamaCaps)).params.extraArgs[0]).toBe('-md');
    let asked = 0;
    await withRecipe(req(), local, sources([recipe()]), async () => (asked++, CAPS));
    expect(asked).toBe(0);
    // vLLM: the context as max-model-len.
    const v = await withRecipe(req({ engine: { kind: 'vllm-docker' } }), local, sources([recipe()]), noCaps);
    expect(v.params).toMatchObject({ maxModelLen: 307_200, ropeScaling: YARN });
    expect(v.applied).toMatchObject({ contextSize: 307_200 });
  });

  it('a draft file named by a path that is gone is said, never passed to the engine', async () => {
    const r = recipe({ draft: 'C:/m/gone-mtp.gguf', contextSize: undefined, ropeScaling: undefined });
    const w = await withRecipe(req(), local, sources([r]), async () => CAPS, undefined, async () => false);
    expect(w.params.extraArgs).toEqual([]);
    expect(w.applied).toMatchObject({ parts: [], skipped: [{ part: 'draft', reason: 'no_file' }] });
    const there = await withRecipe(req(), local, sources([r]), async () => CAPS, undefined, async () => true);
    expect(there.params.extraArgs).toContain('C:/m/gone-mtp.gguf');
    expect(await fileExists(fileURLToPath(import.meta.url))).toBe(true);
    expect(await fileExists(`${fileURLToPath(import.meta.url)}.gone`)).toBe(false);
    // The file next to the model is the library's: never checked again.
    let checked = 0;
    await withRecipe(req(), local, sources([recipe({ draft: 'auto' })]), noCaps, undefined, async () => (checked++, false));
    expect(checked).toBe(0);
  });

  it('one by id or an unsaved one (the editor’s preview) instead of the matching one', async () => {
    const other = recipe({ id: 'other', name: 'Other', match: { name: 'nothing-like-this' }, contextSize: 65_536, ropeScaling: undefined });
    expect((await withRecipe(req({ recipe: { use: true, id: 'other' } }), local, sources([recipe(), other]), noCaps)).params.contextSize).toBe(65_536);
    const inline = await withRecipe(req({ recipe: { use: true, inline: modelRecipeDraftSchema.parse({ name: 'Prova', match: { name: 'qwen' }, args: { llamacpp: ['--jinja'] } }) } }), local, sources([recipe()]), noCaps);
    expect(inline.applied).toMatchObject({ id: 'inline', name: 'Prova', args: ['--jinja'] });
    expect(inline.params.contextSize).toBeUndefined();
  });

  it('the user’s values win and are reported', async () => {
    const w = await withRecipe(req({ params: P({ contextSize: 8192, ropeScaling: { type: 'linear', factor: 2, originalContext: 4096 } }) }), local, sources([recipe()]), noCaps);
    expect(w.params).toMatchObject({ contextSize: 8192, ropeScaling: { type: 'linear' } });
    expect(w.applied).toMatchObject({ overridden: ['context', 'rope'], skipped: [{ part: 'context', reason: 'user' }, { part: 'rope', reason: 'user' }] });
    expect(w.applied).not.toHaveProperty('contextSize');
    expect(w.applied).not.toHaveProperty('ropeScaling');
    // A flag or a variable the user gave is replaced too, but it is not a part that was skipped.
    const flags = await withRecipe(req({ params: P({ extraArgs: ['--jinja', 'off'] }) }), local, sources([recipe({ args: { llamacpp: ['--jinja'] } })]), noCaps);
    expect(flags.applied).toMatchObject({ overridden: ['--jinja'], skipped: [] });
  });

  it('the preferred custom engine replaces a plain engine; the user’s own custom engine or an endpoint stay', async () => {
    const bonsai = recipe({ id: 'bonsai', name: 'Bonsai', engine: { type: 'template', template: 'prismml-bonsai' }, contextSize: undefined, ropeScaling: undefined });
    const w = await withRecipe(req(), local, sources([bonsai], [fork()]), noCaps);
    expect(w.engine).toEqual({ kind: 'llamacpp-native', customEngineId: 'prismml' });
    expect(w.applied).toMatchObject({ parts: ['engine'], engine: { customEngineId: 'prismml', name: 'Fork PrismML' } });
    const docker = await withRecipe(req(), local, sources([recipe({ engine: { type: 'custom', id: 'dock' } })], [fork({ id: 'dock', run: { mode: 'docker', image: 'me/fork:1' } })]), noCaps);
    expect(docker.engine).toEqual({ kind: 'llamacpp-docker', customEngineId: 'dock' });
    const mine = await withRecipe(req({ engine: { kind: 'llamacpp-native', customEngineId: 'my-own' } }), local, sources([bonsai], [fork()]), noCaps);
    expect(mine.engine).toEqual({ kind: 'llamacpp-native', customEngineId: 'my-own' });
    expect(mine.applied?.parts).toEqual([]);
    const ext = await withRecipe(req({ engine: { kind: 'external', baseUrl: 'http://127.0.0.1:1' } }), local, sources([bonsai], [fork()]), noCaps);
    expect(ext.engine.kind).toBe('external');
    // A built-in preference is the page's choice: the core keeps the request's engine.
    expect((await withRecipe(req(), local, sources([recipe({ engine: { type: 'builtin', kind: 'vllm-docker' } })]), noCaps)).engine).toEqual({ kind: 'llamacpp-native' });
  });

  it('NInfer for a .ninfer artifact: in WSL on Windows, natively on Linux; an engine that reads it already stays', async () => {
    const artifact: ModelTarget = { identity: modelIdentity({ format: 'ninfer', displayName: 'Qwen3.8 27B NInfer' }) };
    const ninfer = recipe({ contextSize: undefined, ropeScaling: undefined, engine: { type: 'builtin', kind: 'ninfer-native' } });
    const win = await withRecipe(req(), artifact, sources([ninfer]), noCaps, 'win32');
    expect(win.engine).toEqual({ kind: 'ninfer-wsl' });
    expect(win.applied).toMatchObject({ parts: ['engine'], engine: { kind: 'ninfer-wsl', name: 'ninfer-wsl' } });
    expect((await withRecipe(req(), artifact, sources([ninfer]), noCaps, 'linux')).engine).toEqual({ kind: 'ninfer-native' });
    // A platform where it does not run: the kind as written (the engine then says it is not supported).
    expect((await withRecipe(req(), artifact, sources([ninfer]), noCaps)).engine).toEqual({ kind: 'ninfer-native' });
    const already = await withRecipe(req({ engine: { kind: 'ninfer-wsl', wslDistro: 'Ubuntu' } }), artifact, sources([ninfer]), noCaps, 'win32');
    expect(already.engine).toEqual({ kind: 'ninfer-wsl', wslDistro: 'Ubuntu' });
    expect(already.applied?.parts).toEqual([]);
  });

  it('a template with no saved engine: the rest applies, the guided action is said', async () => {
    const bonsai = recipe({ engine: { type: 'template', template: 'prismml-bonsai' } });
    const w = await withRecipe(req(), local, sources([bonsai], []), noCaps);
    expect(w.engine).toEqual({ kind: 'llamacpp-native' });
    expect(w.applied).toMatchObject({ missingTemplate: 'prismml-bonsai', skipped: [{ part: 'engine', reason: 'engine_missing' }], parts: ['context', 'rope'] });
    expect(recipeWarnings(w.applied)).toEqual([{ code: 'recipe_engine_missing', params: { template: 'prismml-bonsai', recipe: 'Qwen3 4B YaRN' } }]);
    // A saved engine by id that was deleted: not a template, no guided action.
    const gone = await withRecipe(req(), local, sources([recipe({ engine: { type: 'custom', id: 'gone' } })]), noCaps);
    expect(gone.applied).not.toHaveProperty('missingTemplate');
  });

  it('notes: a missing file is said; nothing without a recipe', () => {
    expect(recipeWarnings(undefined)).toEqual([]);
    expect(recipeWarnings({ id: 'r', name: 'R', from: [], parts: [], args: [], envNames: [], overridden: [], skipped: [{ part: 'draft', reason: 'no_file' }, { part: 'rope', reason: 'user' }] })).toEqual([
      { code: 'recipe_file_missing', params: { part: 'draft', recipe: 'R' } },
    ]);
  });

  it('what matching looks at: the hub repo when the identity has none', () => {
    expect(recipeRefOf({ identity: modelIdentity({ repo: undefined }), repo: 'Qwen/Qwen3-4B' })).toMatchObject({ repo: 'Qwen/Qwen3-4B', weakKey: ID.weakKey });
  });
});

describe('BenchService with a recipe', () => {
  const svc = (recipes: ModelRecipe[], over: Parameters<typeof serviceSetup>[1] = {}) => {
    const s = serviceSetup(tmp, { ...over, deps: { resolveModel: async () => local, recipes: async () => sources(recipes), ...over.deps } });
    return { s, service: new BenchService(s.deps) };
  };

  it('the plan says which recipe, launches with it, and a run beyond the trained context warns', async () => {
    const { s, service } = svc([recipe()]);
    const plan = await service.plan(request());
    expect(plan.recipe).toMatchObject({ id: 'qwen-yarn', parts: ['context', 'rope'], contextSize: 307_200 });
    expect(s.adapter.plans.at(-1)?.params).toMatchObject({ contextSize: 307_200, ropeScaling: YARN });
    expect(plan.warnings).toContainEqual({ code: 'context_beyond_trained', params: { contextSize: 307_200, trained: 32_768, factor: 9.375, rope: 'yarn' } });
    // Turned off: the plain launch, no warning.
    const off = await service.plan(request({ recipe: { use: false } }));
    expect(off.recipe).toBeUndefined();
    expect(off.warnings.map((w) => w.code)).not.toContain('context_beyond_trained');
  });

  it('the run saves the recipe and its exact command', async () => {
    const { s, service } = svc([recipe({ args: { llamacpp: ['--jinja'] } })]);
    const { runId } = await service.start(request());
    await service.whenIdle();
    const run = await s.runs.get(runId);
    expect(run?.recipe).toMatchObject({ id: 'qwen-yarn', name: 'Qwen3 4B YaRN', args: ['--jinja'] });
    expect(run?.launch.params).toMatchObject({ contextSize: 307_200, ropeScaling: YARN, extraArgs: ['--jinja'] });
    expect(run?.notes.map((n) => n.code)).toContain('context_beyond_trained');
  });

  it('"Completo" beyond the trained context: the context sweep measures up to it, the duration says how long', async () => {
    const { service } = svc([recipe()]);
    const full = await service.plan(request({ profile: 'full' }));
    expect(full.scenario.steps.find((x) => x.kind === 'context-sweep')).not.toHaveProperty('maxSeconds');
    const plain = await service.plan(request({ profile: 'full', recipe: { use: false } }));
    expect(plain.scenario.steps.find((x) => x.kind === 'context-sweep')).toHaveProperty('maxSeconds', 300);
    // One request at a time: every step of the grid up to the deepest prompt of 300K, 200K included.
    const sweepOnly = { profile: 'custom', seed: 1, steps: [{ kind: 'context-sweep', depths: [], fractions: false, outputTokens: 128, reps: 2, maxSeconds: 300 }] };
    const deep = await service.plan(request({ profile: 'custom', scenario: sweepOnly }));
    const sweep = deep.scenario.steps[0];
    expect(sweep).toEqual({ kind: 'context-sweep', depths: [1024, 4096, 8192, 16384, 32768, 65536, 131_072, 204_800, 262_144, 307_056], fractions: false, outputTokens: 128, reps: 2 });
    // Minutes per deep prompt: the duration says so (well over the 5 minutes of the budget it no longer has).
    expect(deep.estimatedSeconds).toBeGreaterThan(30 * 60);
  });

  it('a server uses it too: the recipe’s context instead of a tune or the estimate', async () => {
    const fits: number[] = [];
    const { service } = svc([recipe()], { deps: { fit: async (_r, _m, p) => (fits.push(p.params?.contextSize ?? 0), undefined) } });
    const plan = await service.planServer(req());
    expect(plan).toMatchObject({ contextSize: 307_200, params: { ropeScaling: YARN }, recipe: { id: 'qwen-yarn' } });
    expect(plan.warnings.map((w) => w.code)).toContain('context_beyond_trained');
    // Only the preview's own fit was asked (no search for a context).
    expect(fits).toEqual([307_200]);
  });

  it('a server with RoPE scaling but no context: the recommended context may go past the trained one', async () => {
    const asked: number[] = [];
    const { service } = svc([recipe({ contextSize: undefined, ropeScaling: { type: 'yarn', factor: 2, originalContext: 16_384 } })], {
      deps: {
        resolveModel: async () => ({ ...local, identity: modelIdentity({ facts: { contextLength: 16_384 } }) }),
        fit: async (_r, _m, p) => {
          asked.push(p.params?.contextSize ?? 0);
          return { level: 'good', needMiB: 1, weightsMiB: 1, kvMiB: 0, overheadMiB: 0, availableMiB: 9, utilization: 0.1, contextSize: 1, basis: 'file-size', notes: [] };
        },
      },
    });
    const plan = await service.planServer(req());
    expect(plan.contextSize).toBe(32_768);
    expect(asked[0]).toBe(32_768);
  });

  it('recipes that cannot be read never block a run; a draft on vLLM never asks llama.cpp’s options', async () => {
    const s = serviceSetup(tmp, { deps: { resolveModel: async () => local, recipes: async () => Promise.reject(new Error('settings')) } });
    expect((await new BenchService(s.deps).plan(request())).recipe).toBeUndefined();
    let asked = 0;
    const v = serviceSetup(tmp, { adapter: { kind: 'vllm-docker' }, deps: { resolveModel: async () => local, recipes: async () => sources([recipe({ draft: 'auto' })]) } });
    v.adapter.capabilities = async () => (asked++, { flags: new Set(), tokenIdsInPrompt: true, timings: true, minTokens: false, fitFlag: false });
    const plan = await new BenchService(v.deps).plan(request({ engine: { kind: 'vllm-docker' } }));
    expect(plan.recipe?.skipped).toContainEqual({ part: 'draft', reason: 'engine' });
    expect(asked).toBe(0);
    // llama.cpp: the build's options are asked (this fake lists none: the plain draft flag).
    const l = serviceSetup(tmp, { deps: { resolveModel: async () => local, recipes: async () => sources([recipe({ draft: 'auto' })]) } });
    const lp = await new BenchService(l.deps).plan(request());
    expect(lp.recipe?.args).toEqual(['-md', 'C:/m/mtp-Qwen3-4B.gguf']);
  });

  it('a built-in engine from a recipe is chosen with this PC’s platform', async () => {
    const artifact: ModelTarget = { identity: modelIdentity({ format: 'ninfer' }) };
    const ninfer = recipe({ contextSize: undefined, ropeScaling: undefined, engine: { type: 'builtin', kind: 'ninfer-native' } });
    const s = serviceSetup(tmp, { deps: { resolveModel: async () => artifact, recipes: async () => sources([ninfer]) } });
    const kinds: string[] = [];
    s.deps.getAdapter = (kind) => (kinds.push(kind), s.adapter as unknown as EngineAdapter);
    // The fingerprint fixture is a Windows PC: NInfer runs in WSL there.
    await new BenchService(s.deps).plan(request());
    expect(kinds).toContain('ninfer-wsl');
  });

  it('a recipe’s custom engine changes the adapter and the request every step uses', async () => {
    const kinds: string[] = [];
    const bonsai = recipe({ contextSize: undefined, ropeScaling: undefined, engine: { type: 'custom', id: 'dock' } });
    const { s, service } = svc([bonsai], {
      deps: {
        recipes: async () => sources([bonsai], [fork({ id: 'dock', run: { mode: 'docker', image: 'me/fork:1' } })]),
        needs: async (r) => (kinds.push(r.engine.kind), []),
      },
    });
    s.deps.getAdapter = (kind) => (kinds.push(`adapter:${kind}`), s.adapter as unknown as EngineAdapter);
    const plan = await service.plan(request());
    expect(plan.recipe?.engine).toEqual({ customEngineId: 'dock', name: 'Fork PrismML' });
    expect(kinds).toContain('adapter:llamacpp-docker');
    expect(kinds).toContain('llamacpp-docker');
  });
});

describe('YaRN in the tuner', () => {
  const prepared = (over: Partial<TunePrepared> = {}): TunePrepared => ({
    model: local,
    adapter: { capabilities: async () => CAPS } as unknown as EngineAdapter,
    engine: { kind: 'llamacpp-native' },
    params: P(),
    launch: { modelBytes: 2_000_000_000 },
    scenario: buildScenario('tune'),
    ...over,
  });
  const deps = {
    telemetry: { snapshot: async () => [] },
    fingerprint: async () => hardware(),
  };

  it('the switch: the search goes up to the target, through the offered targets, YaRN beyond the trained context only', async () => {
    const s = await buildTuneSetup(deps, { engine: { kind: 'llamacpp-native' }, tune: { budget: 'fast', fidelity: false, yarnTarget: 512_000 } }, prepared());
    expect(s.modelContext).toBe(512_000);
    expect(s.contextCandidates).toEqual([307_200, 512_000]);
    const base = s.space.base('q8_0');
    expect(s.space.params(base, 16_384).ropeScaling).toBeUndefined();
    expect(s.space.params(base, 307_200).ropeScaling).toEqual({ type: 'yarn', factor: 9.375, originalContext: 32_768 });
    expect(s.space.params(base, 512_000).ropeScaling?.factor).toBe(15.625);
  });

  it('a recipe’s RoPE scaling is the base: kept on every launch, the search up to its extended context; its draft is not doubled', async () => {
    const p = prepared({ params: P({ ropeScaling: { type: 'yarn', factor: 4, originalContext: 32_768 }, extraArgs: ['-md', 'C:/m/mtp-Qwen3-4B.gguf'] }) });
    const s = await buildTuneSetup(deps, { engine: { kind: 'llamacpp-native' } }, p);
    expect(s.modelContext).toBe(131_072);
    expect(s).not.toHaveProperty('contextCandidates');
    expect(s.space.params(s.space.base('f16'), 8192)).toMatchObject({ ropeScaling: { factor: 4 }, extraArgs: ['-md', 'C:/m/mtp-Qwen3-4B.gguf'] });
    expect(s.space.dimensions.map((d) => d.key)).not.toContain('draft');
    for (const flag of ['--model-draft', '--spec-draft-model']) {
      const other = await buildTuneSetup(deps, { engine: { kind: 'llamacpp-native' } }, prepared({ params: P({ extraArgs: [flag, 'C:/m/d.gguf'] }) }));
      expect(other.space.dimensions.map((d) => d.key)).not.toContain('draft');
    }
    // Without the recipe's draft, the search tries the MTP file itself.
    expect((await buildTuneSetup(deps, { engine: { kind: 'llamacpp-native' } }, prepared())).space.dimensions.map((d) => d.key)).toContain('draft');
  });

  it('no switch for several users, a target within the trained context, or an unknown one; vLLM gets it too', async () => {
    const multi = await buildTuneSetup(deps, { engine: { kind: 'llamacpp-native' }, tune: { budget: 'fast', fidelity: false, goal: 'multi', users: 2, yarnTarget: 512_000 } }, prepared());
    expect(multi.modelContext).toBe(32_768);
    const within = await buildTuneSetup(deps, { engine: { kind: 'llamacpp-native' }, tune: { budget: 'fast', fidelity: false, yarnTarget: 16_384 } }, prepared());
    expect(within.modelContext).toBe(32_768);
    const unknown = await buildTuneSetup(deps, { engine: { kind: 'llamacpp-native' }, tune: { budget: 'fast', fidelity: false, yarnTarget: 512_000 } }, prepared({ model: { identity: modelIdentity() } }));
    expect(unknown).not.toHaveProperty('modelContext');
    const vllm = await buildTuneSetup(deps, { engine: { kind: 'vllm-docker' }, tune: { budget: 'fast', fidelity: false, yarnTarget: 307_200 } }, prepared({ engine: { kind: 'vllm-docker' } }));
    expect(vllm.contextCandidates).toEqual([307_200]);
    expect(vllm.space.params(vllm.space.base('auto'), 307_200)).toMatchObject({ maxModelLen: 307_200, ropeScaling: { factor: 9.375 } });
  });

  it('the capacity search tries the YaRN targets the estimate allows, each once, never below the smallest or past the cap', () => {
    const candidates = (over: Parameters<typeof input>[0]) => {
      const tuner = new Tuner(input(over), { lab: FORECAST_ONLY, now: () => 0 });
      tuner.time();
      return ((tuner as unknown as { capacity: Map<string, Capacity> }).capacity.get('f16') as Capacity).candidates;
    };
    const all = candidates({ modelContext: 512_000, contextCandidates: [2048, 307_200, 512_000, 600_000] });
    expect(all.filter((c) => c > 262_144)).toEqual([307_200, 507_904, 512_000]);
    expect(all.filter((c) => c < 4096)).toEqual([]);
    // The estimate stops at ~280K: 300K is not tried.
    const tight = candidates({
      modelContext: 512_000,
      contextCandidates: [307_200, 512_000],
      predict: (p) => ({ level: 'good', needMiB: (p.contextSize ?? 0) / 10, weightsMiB: 0, kvMiB: 0, overheadMiB: 0, availableMiB: 26_000, utilization: 0, contextSize: 1, basis: 'file-size', notes: [] }),
    });
    expect(tight.some((c) => c > 286_000)).toBe(false);
  });

  it('yarnSpace drops a RoPE scaling within the trained context', () => {
    const inner = { params: () => P({ ropeScaling: { type: 'linear', factor: 2, originalContext: 4096 } }) } as unknown as Parameters<typeof yarnSpace>[0];
    expect(yarnSpace(inner, 32_768).params({ kv: 'f16' }, 8192)).not.toHaveProperty('ropeScaling');
  });

  it('a tune plan beyond the trained context warns, its sweep template untouched', async () => {
    const s = serviceSetup(tmp, { deps: { resolveModel: async () => local } });
    const plan = await new BenchService(s.deps).plan(request({ profile: 'tune', tune: { budget: 'fast', fidelity: false, yarnTarget: 307_200 } }));
    expect(plan.warnings).toContainEqual({ code: 'context_beyond_trained', params: { contextSize: 307_200, trained: 32_768 } });
    expect(plan.scenario).toEqual(buildScenario('tune'));
  });
});

describe('beyond the trained context', () => {
  it('only past the trained context, with the RoPE factor when there is one', () => {
    expect(beyondTrained('llamacpp-native', P({ contextSize: 32_768 }), 32_768)).toBeUndefined();
    expect(beyondTrained('llamacpp-native', P({ contextSize: 65_536 }), undefined)).toBeUndefined();
    expect(beyondTrained('llamacpp-native', P(), 32_768)).toBeUndefined();
    expect(beyondTrained('vllm-docker', P({ maxModelLen: 65_536 }), 32_768)).toEqual({ code: 'context_beyond_trained', params: { contextSize: 65_536, trained: 32_768 } });
  });

  it('a sweep without its time budget keeps every other step as it is', () => {
    const full = buildScenario('full');
    const out = sweepWithoutBudget(full);
    expect(out.steps.find((x) => x.kind === 'context-sweep')).not.toHaveProperty('maxSeconds');
    expect(out.steps.find((x) => x.kind === 'sessions')).toHaveProperty('maxSeconds', 300);
    expect(sweepWithoutBudget(buildScenario('tune'))).toEqual(buildScenario('tune'));
  });
});
