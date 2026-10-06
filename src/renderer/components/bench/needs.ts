/**
 * What has to be installed or downloaded before a run (or a server) can start. The core's plan preview says it
 * exactly (with sizes); until it arrives, or when it cannot be made, the Benchmark page guesses
 * from the engine status and the chosen model so the screen never says "nothing to fetch" by mistake.
 */
import type { RunPlan, StartServerRequest } from '../../../contract/api';
import type { EngineConfig, EngineStatus } from '../../../contract/engines';
import type { ModelOption } from './model-options';

export type DockerEngineKind = 'llamacpp-docker' | 'vllm-docker';

/**
 * Something to fetch first. A model with `file` is one GGUF; without it the whole repo is fetched
 * for vLLM. Either way the run request stays the same: the core finds the downloaded copy itself.
 */
export type Need =
  | { kind: 'engine'; label: string; bytes?: number }
  | { kind: 'image'; engine: DockerEngineKind; label: string; bytes?: number }
  | { kind: 'model'; label: string; bytes?: number; repo: string; revision: string; file?: string };

const isDocker = (kind: string): kind is DockerEngineKind => kind === 'llamacpp-docker' || kind === 'vllm-docker';
const sized = (bytes: number | undefined) => (bytes === undefined ? {} : { bytes });
/** The engine first: if it cannot be installed, nobody waited for a model download in vain. */
const ORDER: Record<Need['kind'], number> = { engine: 0, image: 1, model: 2 };

/**
 * The needs of `request` (a run or a server) as its plan lists them (engine first); `modelLabel`
 * names the model download.
 */
export function needsFromPlan(request: StartServerRequest, plan: Pick<RunPlan, 'needs'>, modelLabel: string): Need[] {
  const out: Need[] = [];
  for (const n of plan.needs) {
    if (n.kind === 'engine') out.push({ kind: 'engine', label: n.label, ...sized(n.bytes) });
    else if (n.kind === 'image') out.push({ kind: 'image', engine: request.engine.kind as DockerEngineKind, label: n.label, ...sized(n.bytes) });
    else {
      // The core lists a model download only for a request that names its HF repo.
      const { repo, file, revision } = request.model as { repo: string; file?: string; revision?: string };
      out.push({ kind: 'model', label: modelLabel, ...sized(n.bytes), repo, revision: revision ?? 'main', ...(file === undefined ? {} : { file }) });
    }
  }
  return out.sort((a, b) => ORDER[a.kind] - ORDER[b.kind]);
}

export interface GuessInput {
  engine: EngineConfig;
  status: EngineStatus | undefined;
  option: ModelOption | undefined;
  modelLabel: string;
}

/** Best guess before the plan: a missing llama.cpp or Docker image, a suggested model not on the PC. */
export function guessNeeds({ engine, status, option, modelLabel }: GuessInput): Need[] {
  const out: Need[] = [];
  if (engine.kind === 'llamacpp-native' && !engine.executable && status?.installed === false) out.push({ kind: 'engine', label: 'llama.cpp' });
  // A custom image may be another one than the status talks about: the plan will tell.
  if (isDocker(engine.kind) && !engine.image && status?.location && status.problems.includes('ENGINE_NOT_INSTALLED')) {
    out.push({ kind: 'image', engine: engine.kind, label: status.location });
  }
  if (option?.source === 'curated') {
    const c = option.curated;
    out.push({ kind: 'model', label: modelLabel, bytes: c.sizeBytes, repo: c.repo, revision: c.revision, ...(c.file === undefined ? {} : { file: c.file }) });
  }
  return out;
}
