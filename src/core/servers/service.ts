import { randomUUID } from 'node:crypto';
import type { ServerInfo, StartServerRequest } from '../../contract/api';
import { launchParamsSchema, type EngineKind } from '../../contract/engines';
import { AppError } from '../../contract/errors';
import type { Clock } from '../deps';
import type { EngineAdapter, EngineInstance, ModelTarget } from '../engines/types';

export interface ServeServiceDeps {
  clock: Clock;
  getAdapter: (kind: EngineKind) => EngineAdapter;
  resolveModel: (req: StartServerRequest) => Promise<ModelTarget>;
  pickPort: () => Promise<number>;
  displayCommand: (argv: string[], env: Record<string, string>) => { powershell: string; bash: string };
  redact: (argv: string[], env: Record<string, string>) => { argv: string[]; env: Record<string, string> };
}

interface Running {
  info: ServerInfo;
  instance: EngineInstance;
}

/**
 * "Avvia solo il server così": starts an engine with a benchmark's exact settings and leaves it
 * running for other programs, until the user stops it (or the app quits).
 */
export class ServeService {
  private readonly running = new Map<string, Running>();

  constructor(private readonly deps: ServeServiceDeps) {}

  list(): ServerInfo[] {
    return [...this.running.values()].map((r) => r.info);
  }

  /** Any server started from here holds VRAM: benchmarks must not start meanwhile. */
  busy(): boolean {
    return this.running.size > 0;
  }

  async start(req: StartServerRequest, signal: AbortSignal): Promise<ServerInfo> {
    const adapter = this.deps.getAdapter(req.engine.kind);
    if (req.engine.kind === 'external') throw new AppError('VALIDATION', 'External endpoints are already running', { params: { reason: 'external' } });
    const model = await this.deps.resolveModel(req);
    const port = await this.deps.pickPort();
    const marker = `gpubench-${randomUUID()}`;
    const plan = await adapter.plan(req.engine, model, req.params ?? launchParamsSchema.parse({}), { port, marker });
    const instance = await adapter.start(plan, signal);
    try {
      await instance.waitReady(signal);
    } catch (e) {
      await instance.stop().catch(() => undefined);
      throw e;
    }
    const shown = this.deps.redact(plan.argv, plan.env);
    const info: ServerInfo = {
      id: marker,
      baseUrl: instance.baseUrl,
      openaiUrl: `${instance.baseUrl}/v1`,
      modelName: model.identity.displayName,
      engineLabel: [plan.engine.name, plan.engine.build ?? plan.engine.version].filter(Boolean).join(' '),
      startedAt: new Date(this.deps.clock.wall()).toISOString(),
      command: { argv: shown.argv, ...this.deps.displayCommand(shown.argv, shown.env) },
    };
    this.running.set(info.id, { info, instance });
    // If the engine dies on its own, forget it.
    void instance.exited.then(() => this.running.delete(info.id));
    return info;
  }

  async stop(id: string): Promise<void> {
    const r = this.running.get(id);
    if (!r) throw new AppError('VALIDATION', 'No such server', { params: { id, reason: 'not_found' } });
    this.running.delete(id);
    await r.instance.stop();
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.running.keys()].map((id) => this.stop(id).catch(() => undefined)));
  }
}
