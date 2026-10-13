/** The models offered for an engine: what is on the PC first, then curated downloads. */
import type { StartRunRequest } from '../../../contract/api';
import type { EngineKind } from '../../../contract/engines';
import type { LocalModel } from '../../../contract/models';
import { engineRunsFormat } from '../../../contract/ninfer';
import { spilledRun, type RunSummary } from '../../../contract/results';
import type { CuratedModel } from '../../../contract/views';

export type ModelOption =
  | {
      key: string;
      source: 'local';
      name: string;
      quant?: string;
      sizeBytes?: number;
      paramsB?: number;
      local: LocalModel;
      /** Where it comes from, in small text under the name ("repo · file", or the file). */
      sub?: string;
    }
  | {
      key: string;
      source: 'curated';
      name: string;
      quant: string;
      sizeBytes: number;
      paramsB: number;
      curated: CuratedModel;
      /** Not a suggestion: the model of a preset ("Usa questo preset"), to download again. */
      preset?: true;
    };

const LLAMA: ReadonlySet<EngineKind> = new Set<EngineKind>(['llamacpp-native', 'llamacpp-docker']);

/** SGLang reads models like vLLM; a command engine takes no launch settings, like an external server. */
export function engineFamily(kind: EngineKind): 'llamacpp' | 'vllm' | 'external' {
  return kind === 'external' || kind === 'command' ? 'external' : LLAMA.has(kind) ? 'llamacpp' : 'vllm';
}

/** What the picker's note says about the formats an engine reads ("llama.cpp usa i modelli GGUF…"). */
export function formatNoteOf(kind: EngineKind): 'llamacpp' | 'vllm' | 'ninfer' | undefined {
  if (engineRunsFormat(kind, 'ninfer')) return 'ninfer';
  if (engineRunsFormat(kind, 'gguf') && !engineRunsFormat(kind, 'safetensors')) return 'llamacpp';
  return engineRunsFormat(kind, 'safetensors') && !engineRunsFormat(kind, 'gguf') ? 'vllm' : undefined;
}

function localOption(m: LocalModel, curated: readonly CuratedModel[]): ModelOption {
  const id = m.identity;
  // A downloaded suggestion keeps its curated name: GGUF metadata names can be odd ("Qwen3 4B Instruct Awq").
  const known = curated.find((c) => sameModel(c, m));
  const sub = [id.repo, id.file && id.file !== id.displayName ? id.file : undefined].filter(Boolean).join(' · ');
  return {
    key: `local:${m.id}`,
    source: 'local',
    name: known ? curatedName(known) : (id.facts?.name ?? id.displayName),
    ...(sub ? { sub } : {}),
    ...(id.quant ? { quant: id.quant } : {}),
    ...(id.sizeBytes !== undefined ? { sizeBytes: id.sizeBytes } : {}),
    ...(id.facts?.paramsB ? { paramsB: id.facts.paramsB } : {}),
    local: m,
  };
}

/** "Qwen3 4B · Q4_K_M" → "Qwen3 4B" (the quant is shown on its own). */
function curatedName(c: CuratedModel): string {
  return c.label.split(' · ')[0]!;
}

function curatedOption(c: CuratedModel): ModelOption {
  return { key: `curated:${c.id}`, source: 'curated', name: curatedName(c), quant: c.quant, sizeBytes: c.sizeBytes, paramsB: c.paramsB, curated: c };
}

/** True when a library model is this curated entry (same file hash, file name or repo). */
function sameModel(c: CuratedModel, m: LocalModel): boolean {
  return (c.sha256 !== undefined && m.identity.sha256 === c.sha256) || (c.file !== undefined && m.identity.file === c.file) || (c.file === undefined && m.identity.repo === c.repo);
}

/** True when a curated entry is already on the PC. */
function isLocal(c: CuratedModel, local: readonly LocalModel[]): boolean {
  return local.some((m) => sameModel(c, m));
}

/**
 * The models an engine can run: those on the PC in its format (contract/ninfer.ts engineRunsFormat: GGUF
 * for llama.cpp, safetensors for vLLM and SGLang, .ninfer for NInfer), never a download stopped halfway,
 * then the suggestions for it.
 */
export function modelOptions(kind: EngineKind, local: readonly LocalModel[], curated: readonly CuratedModel[]): ModelOption[] {
  if (kind === 'external') return [];
  const mine = local.filter((m) => !m.incomplete && engineRunsFormat(kind, m.identity.format));
  // A program of the user's own: the models on the PC it can be given (reading them is its job), no downloads.
  if (kind === 'command') return mine.map((m) => localOption(m, curated));
  const family = engineRunsFormat(kind, 'gguf') ? 'llamacpp' : engineRunsFormat(kind, 'safetensors') ? 'vllm' : undefined;
  return [...mine.map((m) => localOption(m, curated)), ...curated.filter((c) => c.engine === family && !isLocal(c, mine)).map(curatedOption)];
}

/**
 * The saved choice (a local id, "curated:<id>", a bare curated id or a HF repo), else the first
 * local model, else the reference model (small, quick to download, and it gives the score), else
 * the first suggestion. A suggestion downloaded since it was saved is found as
 * its library copy (`curated` is the suggestion list, where it still is).
 */
export function initialModelKey(options: readonly ModelOption[], saved: string | undefined, curated: readonly CuratedModel[] = []): string | undefined {
  if (saved) {
    const downloaded = curated.find((c) => saved === `curated:${c.id}`);
    const hit = options.find(
      (o) =>
        o.key === saved ||
        o.key === `local:${saved}` ||
        o.key === `curated:${saved}` ||
        (o.source === 'curated' ? o.curated.repo === saved : o.local.identity.repo === saved || (downloaded !== undefined && sameModel(downloaded, o.local))),
    );
    if (hit) return hit.key;
  }
  return (options.find((o) => o.source === 'local') ?? options.find((o) => o.source === 'curated' && o.curated.reference === true) ?? options[0])?.key;
}

/** What settings.lastModelId stores for an option. */
export function savedModelId(o: ModelOption): string {
  return o.source === 'local' ? o.local.id : o.key;
}

/**
 * The request's model part. A suggestion is named by its HF repo (and GGUF file): the core plans
 * it before the download, and once downloaded it finds the library copy by itself.
 */
export function requestModel(o: ModelOption): StartRunRequest['model'] {
  if (o.source === 'local') return { localId: o.local.id };
  const { repo, revision, file } = o.curated;
  return file === undefined ? { repo, revision } : { repo, file, revision };
}

/**
 * Newest completed run of this model on this GPU ("Provato su questa GPU"): one that did not spill to
 * shared memory; a run that spilled only when there is no other (its badge then says so).
 */
export function triedOn(o: ModelOption, runs: readonly RunSummary[], gpuName: string | undefined): RunSummary | undefined {
  const matches = (r: RunSummary) => {
    if (o.source === 'local') return (o.local.identity.sha256 !== undefined && r.modelSha256 === o.local.identity.sha256) || r.modelWeakKey === o.local.identity.weakKey;
    const c = o.curated;
    return (c.sha256 !== undefined && r.modelSha256 === c.sha256) || r.modelWeakKey === `${c.repo}@${c.revision}`;
  };
  return newestTried(runs.filter((r) => r.gpuName === gpuName && matches(r)));
}

/** What the "Provato" badge says about a run: its speed, or that it spilled (its speed does not count). */
export function triedHere(r: RunSummary): { tps?: number; date: string; spilled?: boolean } {
  return spilledRun(r) ? { date: r.createdAt, spilled: true } : { tps: r.decodeTps as number, date: r.createdAt };
}

/** The newest completed run with a speed among `runs` (newest first): one that did not spill, else one that did. */
export function newestTried(runs: readonly RunSummary[]): RunSummary | undefined {
  const done = runs.filter((r) => r.status === 'completed' && r.decodeTps !== undefined);
  return done.find((r) => !spilledRun(r)) ?? done[0];
}
