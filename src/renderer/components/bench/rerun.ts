/**
 * A saved run turned back into a request: "Rifai questo benchmark", and its presets ("Usa questo
 * preset" / "Usa queste impostazioni", "Avvia il server così"): engine + model + the full launch
 * params of the run, or of one combination of a "Trova le impostazioni migliori" run.
 */
import type { StartRunRequest, StartServerRequest } from '../../../contract/api';
import { configParamsOf } from '../../../contract/configs';
import type { ApiFlavor, EngineConfig, LaunchParams } from '../../../contract/engines';
import type { LocalModel } from '../../../contract/models';
import { nominalDepth, type LatencyPoint, type Profile, type RunResult } from '../../../contract/results';
import { hasCustomParams } from './expert-form';
import { headlinePoint, isManagedExecutable, modelLabelOf } from './format';
import type { BenchDraft, DraftHubModel, PresetProvenance } from './run-context';

export interface Rerun {
  request: StartRunRequest;
  draft: BenchDraft;
  /** The run's local model is no longer in the library (moved or deleted) and cannot be downloaded again. */
  modelMissing: boolean;
  /** Expert mode is needed to see these settings (custom params, executable, image, endpoint, custom plan). */
  needsExpert: boolean;
}

/** Where the preset's model is: on the PC, to download first (Hugging Face GGUF or vLLM repo), or gone. */
export type PresetModel = 'local' | 'download' | 'missing';

export interface Preset extends Rerun {
  /** "Avvia il server così": engine, model and the exact launch params. */
  serve: StartServerRequest;
  /** The launch params of the preset (the run's, or the combination's: contextSize = its largest context). */
  params: LaunchParams;
  model: PresetModel;
  provenance: PresetProvenance;
}

export interface PresetOptions {
  /** Index into the run's tuning.combinations (ignored for a run without them). */
  combo?: number | undefined;
  /** The depth the provenance quotes (default: the run's headline prompt, a combination's deepest point). */
  at?: number | undefined;
}

/** The library entry for the run's model: same file hash, same weak key, or same path. */
export function findLocalModel(run: Pick<RunResult, 'model'>, local: readonly LocalModel[]): LocalModel | undefined {
  const id = run.model;
  return local.find(
    (m) =>
      (id.sha256 !== undefined && m.identity.sha256 === id.sha256) ||
      m.identity.weakKey === id.weakKey ||
      (id.path !== undefined && m.paths.includes(id.path)),
  );
}

const measured = (points: readonly LatencyPoint[]) => points.filter((p) => p.decodeTps.n > 0);

/**
 * A build GPU Bench installed: in this PC's engines folder, or in the same layout elsewhere (a test
 * from another PC or user in a shared results folder): this PC's own managed build is used instead.
 */
function managedBuild(exe: string, enginesDir: string | undefined): boolean {
  return isManagedExecutable(exe, enginesDir) || /[\\/]engines[\\/]llamacpp[\\/][^\\/]+[\\/]llama-server(?:\.exe)?$/i.test(exe);
}

function provenanceOf(run: RunResult, params: LaunchParams, combo: number | undefined, at: number | undefined): PresetProvenance {
  const combination = combo === undefined ? undefined : run.tuning?.combinations[combo];
  // Runs saved before the context sweep existed have no such list.
  const points = measured(combination ? combination.sweep : [...run.metrics.latency, ...(run.metrics.contextSweep ?? [])]);
  // Depths as the Configurazioni view names them (the deepest prompt of a 32K context is "32K").
  const point =
    at !== undefined
      ? points.find((p) => nominalDepth(p.promptTokens) === at)
      : combination
        ? [...points].sort((a, b) => b.promptTokens - a.promptTokens)[0]
        : headlinePoint(measured(run.metrics.latency)) ?? points[0];
  const contextSize =
    combination?.maxContext ??
    configParamsOf({
      engineKind: run.engine.kind,
      params,
      argv: run.launch.argv,
      image: run.engine.image,
      blockCount: run.model.facts?.blockCount,
      modelContext: run.model.facts?.contextLength,
    }).contextSize;
  return {
    runId: run.id,
    ...(combination ? { combo } : {}),
    label: modelLabelOf(run.model),
    date: run.createdAt,
    ...(point ? { decodeTps: point.decodeTps.median, depth: nominalDepth(point.promptTokens) } : {}),
    ...(contextSize !== undefined ? { contextSize } : {}),
  };
}

function hubModel(run: RunResult, repo: string, file: string | undefined): DraftHubModel {
  const m = run.model;
  return {
    repo,
    ...(file !== undefined ? { file } : {}),
    revision: m.revision ?? 'main',
    name: m.displayName,
    ...(m.quant ? { quant: m.quant } : {}),
    ...(m.sizeBytes !== undefined ? { sizeBytes: m.sizeBytes } : {}),
    ...(m.facts?.paramsB !== undefined ? { paramsB: m.facts.paramsB } : {}),
  };
}

/**
 * The run as a preset. With `combo`, the params are that tune combination's (and the provenance
 * quotes its sweep); a model no longer on the PC is downloaded first when it came from Hugging Face.
 */
export function presetOf(run: RunResult, local: readonly LocalModel[], enginesDir: string | undefined, opts: PresetOptions = {}): Preset {
  const e = run.engine;
  const combination = opts.combo === undefined ? undefined : run.tuning?.combinations[opts.combo];
  const combo = combination ? opts.combo : undefined;
  const params = combination?.params ?? run.launch.params;
  const engine: EngineConfig = { kind: e.kind };
  if (e.kind === 'llamacpp-native' && e.executable && !managedBuild(e.executable, enginesDir)) engine.executable = e.executable;
  if ((e.kind === 'llamacpp-docker' || e.kind === 'vllm-docker') && e.image) engine.image = e.image;
  if (e.kind === 'vllm-native' && e.executable) engine.vllmPath = e.executable;
  if (e.kind === 'external') {
    engine.baseUrl = `http://${run.launch.host}:${run.launch.port}`;
    engine.flavor = (e.variant ?? 'openai') as ApiFlavor;
  }

  // A tune run's own profile searches again: its presets start from the Quick test.
  const draftProfile: Profile = combination || run.scenario.profile === 'tune' ? 'quick' : run.scenario.profile;
  let model: StartRunRequest['model'] = {};
  const draft: BenchDraft = { engine, profile: draftProfile, params };
  let where: PresetModel = 'local';
  if (e.kind === 'external') {
    const name = run.model.displayName.startsWith('http') ? undefined : run.model.displayName;
    if (name) {
      model = { name };
      draft.modelName = name;
    }
  } else if (run.model.source === 'hf' && run.model.repo && run.model.format !== 'gguf') {
    // vLLM: the repo (the core serves the library copy when there is one, else it downloads it).
    const repo = run.model.repo;
    model = { repo, ...(run.model.revision ? { revision: run.model.revision } : {}) };
    draft.repo = repo;
    if (!local.some((m) => m.identity.repo === repo && m.identity.format === 'safetensors')) {
      where = 'download';
      draft.hub = hubModel(run, repo, undefined);
    }
  } else {
    const hit = findLocalModel(run, local);
    const { repo, file, revision } = run.model;
    if (hit) {
      model = { localId: hit.id };
      draft.localId = hit.id;
    } else if (repo && file) {
      // A GGUF downloaded from Hugging Face and deleted since: the plan downloads it again first.
      model = { repo, file, ...(revision ? { revision } : {}) };
      draft.repo = repo;
      draft.hub = hubModel(run, repo, file);
      where = 'download';
    } else where = 'missing';
  }
  const custom = run.scenario.profile === 'custom' && !combination;
  if (custom) draft.scenario = run.scenario;
  draft.provenance = provenanceOf(run, params, combo, opts.at);

  const request: StartRunRequest = {
    engine,
    model,
    profile: run.scenario.profile,
    ...(run.scenario.profile === 'custom' ? { scenario: run.scenario } : {}),
    ...(hasCustomParams(run.launch.params) ? { params: run.launch.params } : {}),
    allowSharedGpu: false,
  };
  const needsExpert = hasCustomParams(params) || custom || e.kind === 'external' || Object.keys(engine).length > 1;
  return {
    request,
    draft,
    modelMissing: where === 'missing',
    needsExpert,
    serve: { engine, model, params },
    params,
    model: where,
    provenance: draft.provenance,
  };
}

/** "Rifai questo benchmark" and "Usa queste impostazioni" of a result: the run itself as a preset. */
export function rerunOf(run: RunResult, local: readonly LocalModel[], enginesDir: string | undefined): Preset {
  return presetOf(run, local, enginesDir);
}
