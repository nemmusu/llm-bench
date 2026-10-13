/**
 * The "Avvia un server" flow without React: what other pages hand over to it (a model, an engine, a
 * test's settings), the engines a model can run on, the tests and presets of a model, and the exact
 * request. Every start of a server goes through this flow (routes/server-start.tsx).
 */
import type { QueryClient } from '@tanstack/react-query';
import type { StartServerRequest } from '../../../contract/api';
import type { ConfigEntry, DepthPoint } from '../../../contract/configs';
import { customEngineKindOf, type CustomEngineInfo, type MissingFlag } from '../../../contract/custom-engines';
import type { EngineConfig, EngineKind, EngineStatus, LaunchParams } from '../../../contract/engines';
import type { ModelIdentity } from '../../../contract/models';
import type { ServerModel, ServerNetwork, ServerPreset, ServerSettingsSource } from '../../../contract/servers';
import type { DraftHubModel, PresetProvenance } from '../bench/run-context';
import { defaultDepth, depthChoices, pointAt } from '../configs/depths';

/** What a page hands to the flow ("Avvia solo il server", "Avvia il server così", "Avvia server", "Modifica"). */
export interface ServerDraft {
  engine?: EngineConfig;
  model?: ServerModel;
  /** The model of a test that is not on the PC any more: downloaded first. */
  hub?: DraftHubModel;
  /** Settings handed over: a test's, or the Benchmark page's expert ones. */
  params?: LaunchParams;
  /** The test those settings come from (the flow says so, with its numbers). */
  provenance?: PresetProvenance;
  /** A saved preset to change ("Modifica"). */
  presetId?: string;
}

const DRAFT_KEY = ['servers', 'draft'] as const;

export function saveServerDraft(qc: QueryClient, draft: ServerDraft): void {
  qc.setQueryDefaults(DRAFT_KEY, { gcTime: Infinity, staleTime: Infinity });
  qc.setQueryData(DRAFT_KEY, draft);
}

/** The pending draft, forgotten once read. */
export function takeServerDraft(qc: QueryClient): ServerDraft | undefined {
  const d = qc.getQueryData<ServerDraft>(DRAFT_KEY);
  if (d) qc.removeQueries({ queryKey: DRAFT_KEY });
  return d;
}

// ---- engines -------------------------------------------------------------------------------------

/** The files an engine reads. */
export type ModelFormat = 'gguf' | 'safetensors';

const BUILTIN: Record<ModelFormat, readonly EngineKind[]> = {
  gguf: ['llamacpp-native', 'llamacpp-docker'],
  safetensors: ['vllm-docker', 'vllm-native', 'sglang-docker', 'sglang-native'],
};

/** The kinds of a format's built-in engines, for a custom engine's base. */
const BASE_FORMATS: Record<CustomEngineInfo['engine']['base'], readonly ModelFormat[]> = {
  llamacpp: ['gguf'],
  vllm: ['safetensors'],
  sglang: ['safetensors'],
  'openai-server': ['gguf', 'safetensors'],
};

export interface EngineChoice {
  /** "builtin:llamacpp-native", "custom:prismml-fork". */
  key: string;
  config: EngineConfig;
  kind: EngineKind;
  /** A custom engine's own name ("PrismML fork"); absent for built-in ones. */
  customName?: string;
  /** Not usable here (the engine is not supported on this OS). */
  disabled: boolean;
  /** Standard settings a fork does not take (left out of its command, its own default applies). */
  missing: MissingFlag[];
}

export function engineKeyOf(config: Pick<EngineConfig, 'kind' | 'customEngineId'>): string {
  return config.customEngineId ? `custom:${config.customEngineId}` : `builtin:${config.kind}`;
}

/** Built-in engines for the model's files first, then the custom engines (forks, command templates) that read them. */
export function engineChoices(format: ModelFormat, statuses: readonly EngineStatus[], customs: readonly CustomEngineInfo[]): EngineChoice[] {
  const builtin = BUILTIN[format].map((kind) => ({
    key: `builtin:${kind}`,
    config: { kind },
    kind,
    disabled: statuses.find((s) => s.kind === kind)?.supported === false,
    missing: [],
  }));
  const custom = customs
    .filter((c) => BASE_FORMATS[c.engine.base].includes(format))
    .map((c) => ({
      key: `custom:${c.engine.id}`,
      config: c.config,
      kind: customEngineKindOf(c.engine),
      customName: c.engine.name,
      disabled: false,
      missing: c.check.missing.filter((m) => m.effect === 'default'),
    }));
  return [...builtin, ...custom];
}

/** The format a model is read in: a GGUF for llama.cpp, a Hugging Face folder for vLLM and SGLang. */
export function formatOf(identity: Pick<ModelIdentity, 'format'>): ModelFormat {
  return identity.format === 'gguf' ? 'gguf' : 'safetensors';
}

// ---- tests and presets of a model ---------------------------------------------------------------

/** A configuration of Risultati → Configurazioni for this model: its headline ("54,6 tok/s a 32K"). */
export interface TestedConfig {
  entry: ConfigEntry;
  /** Its deepest measured point with a generation speed. */
  headline: DepthPoint | undefined;
}

/**
 * The configurations of this model with this engine kind on this card that did not spill, fastest
 * first at the depth most of them measured (the ones not measured there last).
 */
export function testedConfigs(entries: readonly ConfigEntry[], model: Pick<ModelIdentity, 'weakKey' | 'sha256'>, kind: EngineKind): TestedConfig[] {
  const mine = entries.filter((e) => e.engineKind === kind && !e.spill && ((model.sha256 !== undefined && e.model.sha256 === model.sha256) || e.model.weakKey === model.weakKey));
  const depth = defaultDepth(mine, depthChoices(mine));
  const speed = (e: ConfigEntry) => pointAt(e, depth)?.decodeTps ?? -1;
  return [...mine]
    .sort((a, b) => speed(b) - speed(a))
    .map((entry) => ({ entry, headline: [...entry.points].filter((p) => p.decodeTps !== undefined).sort((a, b) => b.depth - a.depth)[0] }));
}

/** Presets saved for this model: same library model, or same Hugging Face file. */
export function presetsForModel(presets: readonly ServerPreset[], model: ServerModel): ServerPreset[] {
  return presets.filter((p) =>
    model.localId !== undefined ? p.model.localId === model.localId : p.model.repo !== undefined && p.model.repo === model.repo && p.model.file === model.file,
  );
}

// ---- the request ----------------------------------------------------------------------------------

export interface FlowChoices {
  engine: EngineConfig;
  model: ServerModel;
  /** undefined = GPU Bench chooses (the latest "Trova le impostazioni migliori", else what fits the card). */
  params: LaunchParams | undefined;
  /** undefined = the first free port from 8080. */
  port: number | undefined;
  network: ServerNetwork;
  /** "Comandi per questo modello" turned off. */
  recipeOff?: boolean;
}

export function serverRequest(c: FlowChoices): StartServerRequest {
  return {
    engine: c.engine,
    model: c.model,
    ...(c.params ? { params: c.params } : {}),
    ...(c.port !== undefined ? { port: c.port } : {}),
    network: c.network,
    ...(c.recipeOff ? { recipe: { use: false } } : {}),
  };
}

/** The port typed in the field: a whole number from 1024 to 65535, '' = automatic, else invalid. */
export function parsePort(text: string): { port: number | undefined; invalid: boolean } {
  const t = text.trim();
  if (!t) return { port: undefined, invalid: false };
  const n = /^\d+$/.test(t) ? Number(t) : NaN;
  return n >= 1024 && n <= 65535 ? { port: n, invalid: false } : { port: undefined, invalid: true };
}

/** Where the settings of a new preset come from. */
export function sourceOf(choice: { kind: 'auto' | 'draft' | 'config' | 'preset' | 'custom'; runId?: string; combo?: number }): ServerSettingsSource {
  if (choice.kind === 'auto') return { kind: 'auto' };
  if ((choice.kind === 'draft' || choice.kind === 'config') && choice.runId !== undefined) {
    return { kind: 'config', runId: choice.runId, ...(choice.combo !== undefined ? { combo: choice.combo } : {}) };
  }
  return { kind: 'custom' };
}
