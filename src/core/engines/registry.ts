import { ENGINE_KINDS, type EngineConfig, type EngineKind, type EngineStatus } from '../../contract/engines';
import { AppError, toAppErrorData } from '../../contract/errors';
import type { EngineAdapter } from './types';

/** kind → adapter. Kinds without an adapter yet (Docker engines, vLLM native: M4) report supported:false. */
export class EngineRegistry {
  private readonly adapters = new Map<EngineKind, EngineAdapter>();

  constructor(adapters: readonly EngineAdapter[] = []) {
    for (const a of adapters) this.adapters.set(a.kind, a);
  }

  get(kind: EngineKind): EngineAdapter | undefined {
    return this.adapters.get(kind);
  }

  require(kind: EngineKind): EngineAdapter {
    const a = this.adapters.get(kind);
    if (!a) throw new AppError('ENGINE_NOT_INSTALLED', `Engine ${kind} is not supported yet`, { params: { kind } });
    return a;
  }

  /** Status of every engine kind, in ENGINE_KINDS order; detection runs in parallel and never throws. */
  async detectAll(configs: Partial<Record<EngineKind, EngineConfig>> = {}): Promise<EngineStatus[]> {
    return Promise.all(
      ENGINE_KINDS.map(async (kind): Promise<EngineStatus> => {
        const a = this.adapters.get(kind);
        if (!a) return { kind, available: false, installed: false, problems: [], supported: false };
        try {
          return await a.detect(configs[kind]);
        } catch (e) {
          return { kind, available: false, installed: false, problems: [toAppErrorData(e).code], supported: true };
        }
      }),
    );
  }
}
