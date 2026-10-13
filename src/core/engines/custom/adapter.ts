/**
 * Custom engines (settings.customEngines) on top of the engine adapters. A config with a
 * `customEngineId` is filled in from the saved engine (its executable, image, Python or command)
 * and goes to its base's adapter: same flags, timings, logs and tuner as the base. Its extra
 * arguments come before the run's own, its environment under the run's own. A fork whose --help
 * lacks some of GPU Bench's flags gets a command without them (PlanOptions.knownFlags) and the plan
 * says which (LaunchPlan.unsupported). Labels, Configurazioni and config keys carry its name
 * (EngineIdentity.name / customEngine).
 */
import { customEngineKindOf, type CustomEngine } from '../../../contract/custom-engines';
import { engineBaseOf, type EngineConfig, type EngineStatus, type LaunchParams } from '../../../contract/engines';
import { AppError, toAppErrorData } from '../../../contract/errors';
import type { CoreEngineConfig, EngineAdapter, EngineCaps, EngineInstance, InstallPlan, LaunchPlan, ModelTarget, PlanOptions, ProgressSink } from '../types';

/** Where the saved engines come from (settings, read on every use: edits apply at once). */
export interface CustomEngineSource {
  list(): Promise<readonly CustomEngine[]>;
}

export interface ResolvedCustom {
  engine: CustomEngine;
  /** The config with the engine's executable / image / Python / command and probe environment. */
  cfg: CoreEngineConfig;
}

/** `cfg` with what the custom engine names (the request's other fields, e.g. a model volume, are kept). */
export function expandCustom(engine: CustomEngine, cfg: EngineConfig): CoreEngineConfig {
  const out: CoreEngineConfig = { ...cfg };
  const run = engine.run;
  if (run.mode === 'docker') out.image = run.image;
  else if (run.mode === 'command') {
    out.command = run.template;
    out.flavor = run.api === 'chat' ? 'openai-chat' : 'openai';
  }
  else if (engine.base === 'llamacpp') out.executable = run.path;
  else if (engine.base === 'vllm') out.vllmPath = run.path;
  else out.sglangPath = run.path;
  if (Object.keys(engine.env).length > 0) out.probeEnv = { ...engine.env };
  return out;
}

/** The saved engine a config names, expanded; undefined for a config without customEngineId. */
export async function resolveCustom(source: CustomEngineSource, cfg: EngineConfig | undefined): Promise<ResolvedCustom | undefined> {
  const id = cfg?.customEngineId;
  if (cfg === undefined || id === undefined) return undefined;
  const engine = (await source.list()).find((e) => e.id === id);
  if (!engine) throw new AppError('ENGINE_NOT_INSTALLED', `Custom engine not found: ${id}`, { params: { reason: 'custom_engine_missing', id } });
  const kind = customEngineKindOf(engine);
  if (kind !== cfg.kind) {
    throw new AppError('VALIDATION', `Custom engine ${id} runs as ${kind}, not ${cfg.kind}`, { params: { reason: 'custom_engine_kind', id, kind } });
  }
  return { engine, cfg: expandCustom(engine, cfg) };
}

/** A fork's launch settings: its extra arguments before the run's, its environment under the run's. */
export function withCustomSettings(engine: Pick<CustomEngine, 'extraArgs' | 'env'>, params: LaunchParams): LaunchParams {
  return { ...params, extraArgs: [...engine.extraArgs, ...params.extraArgs], env: { ...engine.env, ...params.env } };
}

/** Wraps a base adapter: custom configs are expanded, everything else goes straight through. */
export class CustomEngineAdapter implements EngineAdapter {
  readonly kind: EngineAdapter['kind'];
  readonly installPlan?: (cfg: EngineConfig) => Promise<InstallPlan>;
  readonly install?: (plan: InstallPlan, progress: ProgressSink, signal: AbortSignal) => Promise<void>;

  constructor(
    readonly inner: EngineAdapter,
    private readonly source: CustomEngineSource,
  ) {
    this.kind = inner.kind;
    const { installPlan, install } = inner;
    if (installPlan && install) {
      // A fork's Docker image is pulled like the base's ("Scarica").
      this.installPlan = async (cfg) => installPlan.call(inner, (await resolveCustom(this.source, cfg))?.cfg ?? cfg);
      this.install = (plan, progress, signal) => install.call(inner, plan, progress, signal);
    }
  }

  resolve(cfg: EngineConfig | undefined): Promise<ResolvedCustom | undefined> {
    return resolveCustom(this.source, cfg);
  }

  async detect(cfg?: EngineConfig): Promise<EngineStatus> {
    let r: ResolvedCustom | undefined;
    try {
      r = await this.resolve(cfg);
    } catch (e) {
      const err = toAppErrorData(e);
      // resolve() only throws AppErrors that name the engine (reason, id).
      return { kind: this.kind, available: false, installed: false, problems: [err.code], problemParams: err.params as NonNullable<typeof err.params>, supported: true, customEngineId: cfg?.customEngineId as string };
    }
    if (!r) return this.inner.detect(cfg);
    return { ...(await this.inner.detect(r.cfg)), customEngineId: r.engine.id };
  }

  async capabilities(cfg: EngineConfig): Promise<EngineCaps> {
    return this.inner.capabilities((await this.resolve(cfg))?.cfg ?? cfg);
  }

  /**
   * The base's plan for the expanded config. vLLM / SGLang forks are planned with their own --help
   * options (llama.cpp adapters always read their build's); a help that cannot be read leaves
   * every flag in, as for the base.
   */
  async plan(cfg: EngineConfig, model: ModelTarget, params: LaunchParams, opts: PlanOptions): Promise<LaunchPlan> {
    const r = await this.resolve(cfg);
    if (!r) return this.inner.plan(cfg, model, params, opts);
    const base = engineBaseOf(this.kind);
    const known =
      opts.knownFlags ?? (base === 'vllm' || base === 'sglang' ? (await this.inner.capabilities(r.cfg).catch(() => undefined))?.flags : undefined);
    const plan = await this.inner.plan(r.cfg, model, withCustomSettings(r.engine, params), { ...opts, ...(known ? { knownFlags: known } : {}) });
    const { id, name, base: customBase } = r.engine;
    // The stored params are the run's own: "Usa questo preset" adds the engine's again.
    return { ...plan, params, engine: { ...plan.engine, name, customEngine: { id, name, base: customBase } } };
  }

  start(plan: LaunchPlan, signal: AbortSignal): Promise<EngineInstance> {
    return this.inner.start(plan, signal);
  }
}

/** Every adapter wrapped, so a custom config works wherever its kind does. */
export function withCustomEngines(adapters: readonly EngineAdapter[], source: CustomEngineSource): CustomEngineAdapter[] {
  return adapters.map((a) => new CustomEngineAdapter(a, source));
}
