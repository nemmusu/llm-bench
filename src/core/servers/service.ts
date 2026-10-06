import { randomUUID } from 'node:crypto';
import type { ServerInfo, ServerPlan, StartServerRequest } from '../../contract/api';
import { AppError } from '../../contract/errors';
import type { Clock } from '../deps';
import type { EngineAdapter, EngineInstance, LaunchPlan, ModelTarget } from '../engines/types';

/** A server resolved down to its exact command (BenchService.prepareServer). */
export interface ServerLaunch {
  model: ModelTarget;
  adapter: EngineAdapter;
  launch: LaunchPlan;
  /** Tokens the server takes at once (llama.cpp ctx-size, vLLM max-model-len). */
  contextSize?: number;
  /** The model name other programs use (what the server's API reports). */
  apiName?: string;
}

export interface ServeServiceDeps {
  clock: Clock;
  /**
   * Model, engine and exact command with the request's params plus the recommended ones (never a
   * preview: a missing engine or model fails with ENGINE_NOT_INSTALLED / MODEL_NOT_FOUND).
   * `marker` is the ownership marker of the engine process/container.
   */
  prepare: (req: StartServerRequest, marker: string) => Promise<ServerLaunch>;
  /** Preview for POST /api/servers/plan. */
  plan: (req: StartServerRequest) => Promise<ServerPlan>;
  /** Why a server cannot start right now (a benchmark is running), or undefined. */
  blockedBy: () => AppError | undefined;
  displayCommand: (argv: string[], env: Record<string, string>) => { powershell: string; bash: string };
  redact: (argv: string[], env: Record<string, string>) => { argv: string[]; env: Record<string, string> };
  /** Called whenever a server starts or ends (e.g. to refresh the list of our own engine PIDs). */
  onChange: () => void;
}

interface Running {
  info: ServerInfo;
  instance: EngineInstance;
}

/**
 * "Avvia solo il server" (and "… così" from a result): starts an engine with the chosen or
 * recommended settings and leaves it running for other programs, until the user stops it (or the
 * app quits). Only servers started here are ever stopped.
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

  plan(req: StartServerRequest): Promise<ServerPlan> {
    return this.deps.plan(req);
  }

  async start(req: StartServerRequest, signal: AbortSignal): Promise<ServerInfo> {
    const blocked = this.deps.blockedBy();
    if (blocked) throw blocked;
    const marker = `gpubench-${randomUUID()}`;
    const { model, adapter, launch: plan, contextSize, apiName } = await this.deps.prepare(req, marker);
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
      modelName: apiName ?? model.identity.displayName,
      engineLabel: [plan.engine.name, plan.engine.build ?? plan.engine.version].filter(Boolean).join(' '),
      startedAt: new Date(this.deps.clock.wall()).toISOString(),
      command: { argv: shown.argv, ...this.deps.displayCommand(shown.argv, shown.env) },
      contextSize,
    };
    this.running.set(info.id, { info, instance });
    this.deps.onChange();
    // If the engine dies on its own, forget it.
    void instance.exited.then(() => {
      if (this.running.delete(info.id)) this.deps.onChange();
    });
    return info;
  }

  async stop(id: string): Promise<void> {
    const r = this.running.get(id);
    if (!r) throw new AppError('VALIDATION', 'No such server', { params: { id, reason: 'not_found' } });
    this.running.delete(id);
    try {
      await r.instance.stop();
    } finally {
      this.deps.onChange();
    }
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.running.keys()].map((id) => this.stop(id).catch(() => undefined)));
  }
}
