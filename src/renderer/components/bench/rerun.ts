/** A saved run turned back into a request: "Rifai questo benchmark", "Usa queste impostazioni", "Avvia solo il server così". */
import type { StartRunRequest } from '../../../contract/api';
import type { ApiFlavor, EngineConfig } from '../../../contract/engines';
import type { LocalModel } from '../../../contract/models';
import type { RunResult } from '../../../contract/results';
import { hasCustomParams } from './expert-form';
import { isManagedExecutable } from './format';
import type { BenchDraft } from './run-context';

export interface Rerun {
  request: StartRunRequest;
  draft: BenchDraft;
  /** The run's local model is no longer in the library (moved or deleted). */
  modelMissing: boolean;
  /** Expert mode is needed to see these settings (custom params, executable, image, endpoint, custom plan). */
  needsExpert: boolean;
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

export function rerunOf(run: RunResult, local: readonly LocalModel[], enginesDir: string | undefined): Rerun {
  const e = run.engine;
  const engine: EngineConfig = { kind: e.kind };
  if (e.kind === 'llamacpp-native' && e.executable && !isManagedExecutable(e.executable, enginesDir)) engine.executable = e.executable;
  if ((e.kind === 'llamacpp-docker' || e.kind === 'vllm-docker') && e.image) engine.image = e.image;
  if (e.kind === 'vllm-native' && e.executable) engine.vllmPath = e.executable;
  if (e.kind === 'external') {
    engine.baseUrl = `http://${run.launch.host}:${run.launch.port}`;
    engine.flavor = (e.variant ?? 'openai') as ApiFlavor;
  }

  let model: StartRunRequest['model'] = {};
  const draft: BenchDraft = { engine, profile: run.scenario.profile, params: run.launch.params };
  let modelMissing = false;
  if (e.kind === 'external') {
    const name = run.model.displayName.startsWith('http') ? undefined : run.model.displayName;
    if (name) {
      model = { name };
      draft.modelName = name;
    }
  } else if (run.model.source === 'hf' && run.model.repo && run.model.format !== 'gguf') {
    // vLLM: the repo (the core serves the library copy when there is one).
    model = { repo: run.model.repo, ...(run.model.revision ? { revision: run.model.revision } : {}) };
    draft.repo = run.model.repo;
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
    } else modelMissing = true;
  }
  if (run.scenario.profile === 'custom') draft.scenario = run.scenario;

  const request: StartRunRequest = {
    engine,
    model,
    profile: run.scenario.profile,
    ...(run.scenario.profile === 'custom' ? { scenario: run.scenario } : {}),
    ...(hasCustomParams(run.launch.params) ? { params: run.launch.params } : {}),
    allowSharedGpu: false,
  };
  const needsExpert =
    hasCustomParams(run.launch.params) || run.scenario.profile === 'custom' || e.kind === 'external' || Object.keys(engine).length > 1;
  return { request, draft, modelMissing, needsExpert };
}
