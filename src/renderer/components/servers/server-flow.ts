/**
 * The "Avvia un server" flow without React: what other pages hand over to it (a model, an engine, a
 * test's settings), the engines a model can run on, the tests and presets of a model, and the exact
 * request. Every start of a server goes through this flow (routes/server-start.tsx).
 */
import type { QueryClient } from '@tanstack/react-query';
import type { StartServerRequest } from '../../../contract/api';
import type { ConfigEntry, DepthPoint } from '../../../contract/configs';
import { CUSTOM_BASE_FORMATS, customEngineKindOf, type CustomEngineInfo, type MissingFlag } from '../../../contract/custom-engines';
import type { EngineConfig, EngineKind, EngineStatus, LaunchParams } from '../../../contract/engines';
import type { LocalModel, ModelIdentity } from '../../../contract/models';
import type { ServerModel, ServerNetwork, ServerPreset, ServerSettingsSource } from '../../../contract/servers';
import { ninferKindFor } from '../../../contract/ninfer';
import type { CuratedModel } from '../../../contract/views';
import { modelOptions, requestModel, type ModelOption } from '../bench/model-options';
import type { DraftHubModel, PresetProvenance } from '../bench/run-context';
import { defaultDepth, depthChoices, pointAt } from '../configs/depths';
import { hubOption } from '../presets/use-preset-draft';

/** What a page hands to the flow ("Avvia solo il server", "Avvia il server così", "Avvia server", "Modifica"). */
export interface ServerDraft {
  /** The engine chosen elsewhere (a test's, a preset's, the Benchmark's): it wins over the model's recipe. */
  engine?: EngineConfig;
  /** A likely engine (Models → "Avvia server"): used when neither the user nor the model's recipe chose one. */
  suggestedEngine?: EngineConfig;
  /** "Usa i comandi di questo modello" was turned off where the flow was opened. */
  recipeOff?: boolean;
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
export type ModelFormat = 'gguf' | 'safetensors' | 'ninfer';

/** Built-in engines of a format; NInfer runs natively on Linux and through WSL on Windows. */
function builtinKinds(format: ModelFormat, platform: string): EngineKind[] {
  if (format === 'gguf') return ['llamacpp-native', 'llamacpp-docker'];
  if (format === 'safetensors') return ['vllm-docker', 'vllm-native', 'sglang-docker', 'sglang-native', 'trtllm-docker', 'trtllm-native'];
  const ninfer = ninferKindFor(platform);
  return ninfer ? [ninfer] : [];
}

/** The formats a custom engine reads, by its base (a command template never reads a .ninfer artifact). */
export interface EngineChoice {
  /** "builtin:llamacpp-native", "custom:prismml-fork". */
  key: string;
  config: EngineConfig;
  kind: EngineKind;
  /** A custom engine's own name ("PrismML fork"); absent for built-in ones. */
  customName?: string;
  /** What a custom engine is built on ("Fork di llama.cpp"); absent for built-in ones. */
  base?: CustomEngineInfo['engine']['base'];
  /** Not usable here (the engine is not supported on this OS). */
  disabled: boolean;
  /** Standard settings a fork does not take (left out of its command, its own default applies). */
  missing: MissingFlag[];
}

export function engineKeyOf(config: Pick<EngineConfig, 'kind' | 'customEngineId'>): string {
  return config.customEngineId ? `custom:${config.customEngineId}` : `builtin:${config.kind}`;
}

/**
 * The built-in engines for the model's files, each followed by the custom engines built on it, as the
 * Benchmark page lists them ("llama.cpp", then "llama.cpp · PrismML"); programs of the user's own last.
 */
export function engineChoices(format: ModelFormat, statuses: readonly EngineStatus[], customs: readonly CustomEngineInfo[], platform: string): EngineChoice[] {
  const unsupported = (kind: EngineKind) => statuses.find((s) => s.kind === kind)?.supported === false;
  const custom = customs
    .filter((c) => CUSTOM_BASE_FORMATS[c.engine.base].includes(format))
    .map((c): EngineChoice => {
      const kind = customEngineKindOf(c.engine);
      return {
        key: `custom:${c.engine.id}`,
        config: c.config,
        kind,
        customName: c.engine.name,
        base: c.engine.base,
        disabled: unsupported(kind),
        missing: c.check.missing.filter((m) => m.effect === 'default'),
      };
    });
  const kinds = builtinKinds(format, platform);
  const grouped = kinds.flatMap((kind): EngineChoice[] => [{ key: `builtin:${kind}`, config: { kind }, kind, disabled: unsupported(kind), missing: [] }, ...custom.filter((c) => c.kind === kind)]);
  return [...grouped, ...custom.filter((c) => !kinds.includes(c.kind))];
}

/** The format a model is read in: a GGUF for llama.cpp, a .ninfer artifact for NInfer, a Hugging Face folder for vLLM and SGLang. */
export function formatOf(identity: Pick<ModelIdentity, 'format'>): ModelFormat {
  return identity.format === 'gguf' || identity.format === 'ninfer' ? identity.format : 'safetensors';
}

// ---- models --------------------------------------------------------------------------------------

/** A .ninfer artifact on the PC (the Benchmark page's lists have GGUF and safetensors only). */
function ninferOption(m: LocalModel): ModelOption {
  const id = m.identity;
  return {
    key: `local:${m.id}`,
    source: 'local',
    name: id.facts?.name ?? id.displayName,
    ...(id.quant ? { quant: id.quant } : {}),
    ...(id.sizeBytes !== undefined ? { sizeBytes: id.sizeBytes } : {}),
    local: m,
  };
}

const sameHub = (o: ModelOption, hub: DraftHubModel): boolean =>
  o.source === 'curated' ? o.curated.repo === hub.repo && o.curated.file === hub.file : o.local.identity.repo === hub.repo && o.local.identity.file === hub.file;

/**
 * Every model a server can run: GGUF and Hugging Face folders on the PC and the suggestions for this
 * card, the .ninfer artifacts, and a test's model to download again (when it is not one of them).
 */
export function serverModelOptions(local: readonly LocalModel[], curated: readonly CuratedModel[], hub?: DraftHubModel): ModelOption[] {
  const all = [...modelOptions('llamacpp-native', local, curated), ...modelOptions('vllm-docker', local, curated), ...local.filter((m) => m.identity.format === 'ninfer').map(ninferOption)];
  if (hub && !all.some((o) => sameHub(o, hub))) all.push(hubOption(hub));
  return all;
}

export function optionFormat(o: ModelOption): ModelFormat {
  return o.source === 'local' ? formatOf(o.local.identity) : o.curated.file === undefined ? 'safetensors' : 'gguf';
}

/** The option a draft (or a preset being changed) names: same library model, or same Hugging Face file. */
export function optionFor(options: readonly ModelOption[], model: ServerModel | undefined): ModelOption | undefined {
  if (!model) return undefined;
  if (model.localId !== undefined) return options.find((o) => o.source === 'local' && o.local.id === model.localId);
  return options.find((o) => (o.source === 'curated' ? o.curated.repo === model.repo && o.curated.file === model.file : o.local.identity.repo === model.repo && o.local.identity.file === model.file));
}

/** The request's model part of an option. */
export function optionModel(o: ModelOption): ServerModel {
  return requestModel(o) as ServerModel;
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

export type FlowChoices = {
  engine: EngineConfig;
  model: ServerModel;
  /** undefined = LLM Bench chooses (the latest "Trova le impostazioni migliori", else what fits the card). */
  params: LaunchParams | undefined;
  /** undefined = the first free port from 8080. */
  port: number | undefined;
  network: ServerNetwork;
} & Pick<StartServerRequest, 'recipe'>;

/** The request of these choices; `recipe` is useModelRecipe's requestPart (nothing = the core applies the model's recipe). */
export function serverRequest(c: FlowChoices): StartServerRequest {
  return {
    engine: c.engine,
    model: c.model,
    ...(c.params ? { params: c.params } : {}),
    ...(c.port !== undefined ? { port: c.port } : {}),
    network: c.network,
    ...(c.recipe ? { recipe: c.recipe } : {}),
  };
}

/** The port typed in the field: a whole number from 1024 to 65535, '' = automatic, else invalid. */
export function parsePort(text: string): { port: number | undefined; invalid: boolean } {
  const t = text.trim();
  if (!t) return { port: undefined, invalid: false };
  const n = /^\d+$/.test(t) ? Number(t) : NaN;
  return n >= 1024 && n <= 65535 ? { port: n, invalid: false } : { port: undefined, invalid: true };
}

/**
 * Where the settings of a new preset come from: LLM Bench's choice (the tune it used, if any), a test
 * (handed over, or one of the model's configurations; a tune's combination too), else the user's own.
 */
export function presetSource(c: { tab: 'best' | 'presets' | 'custom'; best: string; tunedRunId: string | undefined; test: { runId: string; combo?: number | undefined } | undefined }): ServerSettingsSource {
  if (c.tab !== 'best') return { kind: 'custom' };
  if (c.best === 'auto') return c.tunedRunId !== undefined ? { kind: 'tuned', runId: c.tunedRunId } : { kind: 'auto' };
  if (!c.test) return { kind: 'custom' };
  return { kind: 'config', runId: c.test.runId, ...(c.test.combo !== undefined ? { combo: c.test.combo } : {}) };
}
