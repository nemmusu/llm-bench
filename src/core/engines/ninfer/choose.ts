/**
 * Which build of NInfer runs a model (contract/ninfer.ts ninferBuildFor): a .ninfer artifact whose
 * manifest lists a layout only NInfer-all reads runs on NInfer-all, whatever NInfer build the request
 * named — on the Benchmark, in "Trova le impostazioni migliori", for a server, a preset or "Usa queste
 * impostazioni" alike (they all come through BenchService.prepare / prepareServer). A request that names
 * a NInfer program by its path, or another variant of NInfer on purpose, is left as it is.
 */
import { customEngineConfigOf, isNinferAllEngine, ninferAllEngineOf, type CustomEngine } from '../../../contract/custom-engines';
import type { EngineConfig } from '../../../contract/engines';
import { isNinferKind, ninferBuildFor, type NinferBuildChoice, type NinferBuildModel } from '../../../contract/ninfer';

export interface NinferBuildPick {
  /** The engine that runs the model: NInfer-all's saved engine when it is there and needed. */
  engine: EngineConfig;
  /** The model needs NInfer-all (`ready` false: not saved yet). */
  choice?: NinferBuildChoice;
  /** The request already named NInfer-all (nothing was switched). */
  asked?: boolean;
}

export function chooseNinferBuild(engine: EngineConfig, model: NinferBuildModel, customEngines: readonly CustomEngine[]): NinferBuildPick {
  if (!isNinferKind(engine.kind) || engine.ninferPath !== undefined) return { engine };
  const need = ninferBuildFor(model);
  if (need.build === 'official') return { engine };
  const named = engine.customEngineId === undefined ? undefined : customEngines.find((e) => e.id === engine.customEngineId);
  // Another variant chosen on purpose (a fork of the user's): theirs to say whether it reads the model.
  if (engine.customEngineId !== undefined && (named === undefined || !isNinferAllEngine(named))) return { engine };
  const all = named ?? ninferAllEngineOf(customEngines, engine.kind);
  const base = { build: 'all' as const, why: need.why, layout: need.layout };
  if (!all) return { engine, choice: { ...base, ready: false } };
  return { engine: customEngineConfigOf(all), choice: { ...base, ready: true, customEngineId: all.id }, ...(named ? { asked: true } : {}) };
}
