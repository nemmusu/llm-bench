/** The models offered for an engine: what is on the PC first, then curated downloads. */
import type { StartRunRequest } from '../../../contract/api';
import type { EngineKind } from '../../../contract/engines';
import type { LocalModel } from '../../../contract/models';
import type { RunSummary } from '../../../contract/results';
import type { CuratedModel } from '../../../contract/views';

export type ModelOption =
  | { key: string; source: 'local'; name: string; quant?: string; sizeBytes?: number; paramsB?: number; local: LocalModel }
  | { key: string; source: 'curated'; name: string; quant: string; sizeBytes: number; paramsB: number; curated: CuratedModel };

const LLAMA: ReadonlySet<EngineKind> = new Set<EngineKind>(['llamacpp-native', 'llamacpp-docker']);

export function engineFamily(kind: EngineKind): 'llamacpp' | 'vllm' | 'external' {
  return kind === 'external' ? 'external' : LLAMA.has(kind) ? 'llamacpp' : 'vllm';
}

function localOption(m: LocalModel): ModelOption {
  const id = m.identity;
  return {
    key: `local:${m.id}`,
    source: 'local',
    name: id.facts?.name ?? id.displayName,
    ...(id.quant ? { quant: id.quant } : {}),
    ...(id.sizeBytes !== undefined ? { sizeBytes: id.sizeBytes } : {}),
    ...(id.facts?.paramsB ? { paramsB: id.facts.paramsB } : {}),
    local: m,
  };
}

function curatedOption(c: CuratedModel): ModelOption {
  return { key: `curated:${c.id}`, source: 'curated', name: c.label.split(' · ')[0]!, quant: c.quant, sizeBytes: c.sizeBytes, paramsB: c.paramsB, curated: c };
}

/** True when a curated entry is already on the PC (same file hash, file name or repo). */
function isLocal(c: CuratedModel, local: readonly LocalModel[]): boolean {
  return local.some(
    (m) =>
      (c.sha256 !== undefined && m.identity.sha256 === c.sha256) ||
      (c.file !== undefined && m.identity.file === c.file) ||
      (c.file === undefined && m.identity.repo === c.repo),
  );
}

export function modelOptions(kind: EngineKind, local: readonly LocalModel[], curated: readonly CuratedModel[]): ModelOption[] {
  const family = engineFamily(kind);
  if (family === 'external') return [];
  const format = family === 'llamacpp' ? 'gguf' : 'safetensors';
  const mine = local.filter((m) => m.identity.format === format);
  return [...mine.map(localOption), ...curated.filter((c) => c.engine === family && !isLocal(c, mine)).map(curatedOption)];
}

/**
 * The saved choice (a local id, "curated:<id>", a bare curated id or a HF repo), else the first
 * local model, else the first suggestion.
 */
export function initialModelKey(options: readonly ModelOption[], saved: string | undefined): string | undefined {
  if (saved) {
    const hit = options.find(
      (o) =>
        o.key === saved ||
        o.key === `local:${saved}` ||
        o.key === `curated:${saved}` ||
        (o.source === 'curated' ? o.curated.repo === saved : o.local.identity.repo === saved),
    );
    if (hit) return hit.key;
  }
  return (options.find((o) => o.source === 'local') ?? options[0])?.key;
}

/** What settings.lastModelId stores for an option. */
export function savedModelId(o: ModelOption): string {
  return o.source === 'local' ? o.local.id : o.key;
}

/** The request's model part; undefined while a GGUF suggestion still has to be downloaded. */
export function requestModel(o: ModelOption): StartRunRequest['model'] | undefined {
  if (o.source === 'local') return { localId: o.local.id };
  if (o.curated.engine === 'vllm') return { repo: o.curated.repo, revision: o.curated.revision };
  return undefined;
}

/** Newest completed run of this model on this GPU ("Provato su questa GPU"). */
export function triedOn(o: ModelOption, runs: readonly RunSummary[], gpuName: string | undefined): RunSummary | undefined {
  const matches = (r: RunSummary) => {
    if (o.source === 'local') return (o.local.identity.sha256 !== undefined && r.modelSha256 === o.local.identity.sha256) || r.modelWeakKey === o.local.identity.weakKey;
    const c = o.curated;
    return (c.sha256 !== undefined && r.modelSha256 === c.sha256) || r.modelWeakKey === `${c.repo}@${c.revision}`;
  };
  return runs.find((r) => r.status === 'completed' && r.decodeTps !== undefined && r.gpuName === gpuName && matches(r));
}
