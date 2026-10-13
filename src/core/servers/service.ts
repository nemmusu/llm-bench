import { randomUUID } from 'node:crypto';
import type { ServerInfo, ServerPlan, StartServerRequest } from '../../contract/api';
import { AppError } from '../../contract/errors';
import type { ServerLog, ServerNetwork, ServerNotice } from '../../contract/servers';
import type { Clock } from '../deps';
import { LoadTracker } from '../engines/shared/load-progress';
import type { EngineAdapter, EngineInstance, LaunchPlan, ModelTarget } from '../engines/types';
import { redactSecrets } from './lan';
import type { ServerNotices } from './notices';
import type { ServerPorts } from './ports';
import { presetRequest, type ServerPresets } from './presets';

/** A server resolved down to its exact command (BenchService.prepareServer). */
export interface ServerLaunch {
  model: ModelTarget;
  adapter: EngineAdapter;
  launch: LaunchPlan;
  /** Tokens the server takes at once (llama.cpp ctx-size, vLLM max-model-len). */
  contextSize?: number;
  /** The model name other programs use (what the server's API reports). */
  apiName?: string;
  /** Usual start → ready time of this model with this engine on this PC, when known. */
  expectedLoadMs?: number;
}

export interface ServeServiceDeps {
  clock: Clock;
  /**
   * Model, engine and exact command with the request's params plus the recommended ones (never a
   * preview: a missing engine or model fails with ENGINE_NOT_INSTALLED / MODEL_NOT_FOUND). The
   * request always has its port and network here. `marker` is the ownership marker of the engine.
   */
  prepare: (req: StartServerRequest, marker: string) => Promise<ServerLaunch>;
  /** Preview for POST /api/servers/plan (the request has its port and network). */
  plan: (req: StartServerRequest) => Promise<ServerPlan>;
  /** Why a server cannot start right now (a benchmark is running), or undefined. */
  blockedBy: () => AppError | undefined;
  displayCommand: (argv: string[], env: Record<string, string>) => { powershell: string; bash: string };
  redact: (argv: string[], env: Record<string, string>) => { argv: string[]; env: Record<string, string> };
  /** Called whenever a server starts, becomes ready or ends (our engine PIDs, the tray, the UI). */
  onChange: () => void;
  ports: ServerPorts;
  /** The addresses other devices use for a server shared on the local network ("http://192.168.1.20:8080/v1"). */
  lanUrls: (port: number) => string[];
  /** API keys to hide in the engine's output. */
  secrets: () => string[];
  /** GPU memory in use now (MiB), to tell how much a server took. */
  vramUsedMiB?: () => Promise<number | undefined>;
  presets?: ServerPresets;
  notices?: ServerNotices;
  /** A start nobody was watching failed (the main process shows a notification). */
  notify?: (name: string) => void;
  /** A ready server ended on its own (not stopped from here): a Docker one may have been taken down by Docker. */
  onEnded?: (info: ServerInfo) => void;
}

interface Running {
  info: ServerInfo;
  instance: EngineInstance;
  /** Still starting: aborts the start (DELETE while loading). */
  cancel?: () => void;
}

const notFound = (id: string) => new AppError('VALIDATION', 'No such server', { params: { id, reason: 'not_found' } });

/** "Qwen3 8B · Q4_K_M": the model's own name (GGUF metadata) and its quantization, as the library shows it. */
export function modelLabelOf(identity: Pick<ModelTarget['identity'], 'displayName' | 'quant' | 'facts'>): string {
  const name = identity.facts?.name ?? identity.displayName;
  return identity.quant && !name.includes(identity.quant) ? `${name} · ${identity.quant}` : name;
}

/**
 * The servers of the Server page ("Avvia un server", a preset, "Avvia il server così", the tray):
 * an engine started with the chosen or recommended settings on a stable port, left running for other
 * programs until the user stops it (or quits LLM Bench). Only servers started here are ever stopped.
 */
export class ServeService {
  private readonly running = new Map<string, Running>();
  /** Ports chosen for starts still being prepared (not in `running` yet). */
  private readonly reserved = new Set<number>();
  /** Port choices one at a time: two starts at once must never both get 8080. */
  private portLock: Promise<unknown> = Promise.resolve();
  /** Engines being stopped (shutdown waits for them). */
  private readonly stopping = new Set<Promise<unknown>>();

  constructor(private readonly deps: ServeServiceDeps) {}

  list(): ServerInfo[] {
    return [...this.running.values()].map((r) => r.info);
  }

  /** Any server started from here holds VRAM: benchmarks must not start meanwhile. */
  busy(): boolean {
    return this.running.size > 0;
  }

  /** Ports of our servers, the ones still starting included. */
  private portsInUse(): number[] {
    return [...[...this.running.values()].map((r) => r.info.port), ...this.reserved];
  }

  /** The request's port when given, else the first free one from 8080 (nothing reserved). */
  private suggest(req: StartServerRequest): Promise<number> {
    return req.port !== undefined ? Promise.resolve(req.port) : this.deps.ports.suggest(this.portsInUse());
  }

  /** Why `port` cannot be used for a new server: one of ours has it, or another program does. */
  private async portProblem(port: number): Promise<{ code: 'port_ours'; model: string } | { code: 'port_taken' } | undefined> {
    const ours = [...this.running.values()].find((r) => r.info.port === port);
    if (ours) return { code: 'port_ours', model: ours.info.modelLabel };
    if (this.reserved.has(port)) return { code: 'port_ours', model: '' };
    return (await this.deps.ports.free(port)) ? undefined : { code: 'port_taken' };
  }

  /** Picks and reserves the port of a start, one start at a time. Released by `start` in any case. */
  private reservePort(req: StartServerRequest): Promise<number> {
    const next = this.portLock.then(async () => {
      const port = await this.suggest(req);
      const problem = await this.portProblem(port);
      if (problem) {
        throw new AppError('ENGINE_PORT_IN_USE', `Port ${port} is already in use`, {
          params: { port, reason: problem.code, ...(problem.code === 'port_ours' && problem.model ? { model: problem.model } : {}) },
        });
      }
      this.reserved.add(port);
      return port;
    });
    this.portLock = next.catch(() => undefined);
    return next;
  }

  /** Preview with the port it would use (and what is wrong with a chosen one) and, on the network, its addresses. */
  async plan(req: StartServerRequest): Promise<ServerPlan> {
    const network = req.network ?? 'local';
    const port = await this.suggest(req);
    const plan = await this.deps.plan({ ...req, port, network });
    const problem = req.port !== undefined ? await this.portProblem(port) : undefined;
    const warnings = problem ? [...plan.warnings, { code: problem.code, params: { port, ...(problem.code === 'port_ours' ? { model: problem.model } : {}) } }] : plan.warnings;
    return { ...plan, warnings, port, network, ...(network === 'lan' ? { lanUrls: this.deps.lanUrls(port) } : {}) };
  }

  async start(req: StartServerRequest, signal: AbortSignal): Promise<ServerInfo> {
    const blocked = this.deps.blockedBy();
    if (blocked) throw blocked;
    if (req.presetId !== undefined && this.list().some((s) => s.presetId === req.presetId)) {
      throw new AppError('VALIDATION', 'This preset is already running', { params: { reason: 'preset_running' } });
    }
    const port = await this.reservePort(req);
    try {
      return await this.launch({ ...req, port, network: req.network ?? 'local' }, port, signal);
    } finally {
      this.reserved.delete(port);
    }
  }

  private async launch(request: StartServerRequest & { port: number; network: ServerNetwork }, port: number, signal: AbortSignal): Promise<ServerInfo> {
    const marker = `gpubench-${randomUUID()}`;
    const { model, adapter, launch: plan, contextSize, apiName, expectedLoadMs } = await this.deps.prepare(request, marker);
    const presetName = request.presetId !== undefined ? (await this.deps.presets?.get(request.presetId).catch(() => undefined))?.name : undefined;
    // Cancelled by the caller (shutdown) or by DELETE while it is still loading.
    const starting = new AbortController();
    const cancel = () => starting.abort();
    if (signal.aborted) cancel();
    signal.addEventListener('abort', cancel, { once: true });
    const before = await this.deps.vramUsedMiB?.().catch(() => undefined);
    let instance: EngineInstance;
    try {
      instance = await adapter.start(plan, starting.signal);
    } catch (e) {
      signal.removeEventListener('abort', cancel);
      throw e;
    }
    const shown = this.deps.redact(plan.argv, plan.env);
    const network = request.network;
    const info: ServerInfo = {
      id: marker,
      baseUrl: instance.baseUrl,
      openaiUrl: `${instance.baseUrl}/v1`,
      modelName: apiName ?? model.identity.displayName,
      modelLabel: modelLabelOf(model.identity),
      engineLabel: [plan.engine.customEngine?.name ?? plan.engine.name, plan.engine.build ?? plan.engine.version].filter(Boolean).join(' '),
      engineKind: plan.kind,
      startedAt: new Date(this.deps.clock.wall()).toISOString(),
      command: { argv: shown.argv, ...this.deps.displayCommand(shown.argv, shown.env) },
      contextSize,
      params: plan.params,
      ...(model.identity.facts?.blockCount !== undefined ? { blockCount: model.identity.facts.blockCount } : {}),
      port,
      network,
      lanUrls: network === 'lan' ? this.deps.lanUrls(port) : [],
      request,
      ...(request.presetId !== undefined ? { presetId: request.presetId } : {}),
      ...(presetName !== undefined ? { presetName } : {}),
    };
    // Listed while it loads (with what it is doing now), so the servers list can show it.
    const entry: Running = { info, instance, cancel };
    this.running.set(info.id, entry);
    this.deps.onChange();
    const loading = new LoadTracker({
      kind: plan.kind,
      t0: instance.t0,
      now: () => this.deps.clock.now(),
      emit: (p) => {
        if (entry.cancel) entry.info = { ...entry.info, loading: p };
      },
      ...(expectedLoadMs !== undefined ? { expectedMs: expectedLoadMs } : {}),
    });
    // Draining the log also keeps it from piling up while the server runs.
    void (async () => {
      for await (const line of instance.logs) loading.line(line.text, line.t);
    })().catch(() => undefined);
    try {
      await instance.waitReady(starting.signal);
    } catch (e) {
      if (this.running.get(info.id) === entry) {
        this.running.delete(info.id);
        this.deps.onChange();
      }
      await this.track(instance.stop().catch(() => undefined));
      throw e;
    } finally {
      signal.removeEventListener('abort', cancel);
    }
    delete entry.cancel;
    loading.ready();
    const { loading: _done, ...ready } = entry.info;
    const after = before === undefined ? undefined : await this.deps.vramUsedMiB?.().catch(() => undefined);
    const took = after === undefined || before === undefined ? undefined : after - before;
    entry.info = { ...ready, ...(took !== undefined && took > 0 ? { vramMiB: took } : {}) };
    if (request.presetId !== undefined) this.deps.notices?.clearPreset(request.presetId);
    this.deps.onChange();
    // If the engine dies on its own, forget it.
    void instance.exited.then(() => {
      if (this.running.get(info.id) === entry) {
        this.running.delete(info.id);
        this.deps.onChange();
        this.deps.onEnded?.(entry.info);
      }
    });
    return entry.info;
  }

  /** "Riavvia": the same request again (same port, same settings, same preset), once the old engine has gone. */
  async restart(id: string, signal: AbortSignal): Promise<ServerInfo> {
    const r = this.running.get(id);
    if (!r) throw notFound(id);
    await this.stop(id);
    return this.start(r.info.request, signal);
  }

  /** Starts a saved preset. */
  async startPreset(id: string, signal: AbortSignal): Promise<ServerInfo> {
    const presets = this.deps.presets;
    if (!presets) throw new AppError('VALIDATION', 'Presets are not available', { params: { reason: 'preset_not_found', id } });
    return this.start(presetRequest(await presets.get(id)), signal);
  }

  /**
   * A start nobody watches (at start-up, from the tray): never throws; a failure becomes a notice on the
   * Server page and a notification. A preset that is already running is left alone.
   */
  async startUnattended(id: string, kind: ServerNotice['kind'], signal: AbortSignal): Promise<ServerInfo | undefined> {
    const preset = await this.deps.presets?.get(id).catch(() => undefined);
    if (!preset || this.list().some((s) => s.presetId === id)) return undefined;
    try {
      return await this.startPreset(id, signal);
    } catch (e) {
      if (signal.aborted) return undefined;
      this.deps.notices?.add(kind, preset, e);
      this.deps.notify?.(preset.name);
      return undefined;
    }
  }

  /** "Avvia all'apertura di LLM Bench": every marked preset, one after the other. */
  async autoStart(signal: AbortSignal): Promise<void> {
    for (const p of (await this.deps.presets?.autoStart()) ?? []) {
      if (signal.aborted) return;
      await this.startUnattended(p.id, 'autostart-failed', signal);
    }
  }

  /** The engine's own output, its last lines, with every API key hidden. */
  log(id: string): ServerLog {
    const r = this.running.get(id);
    if (!r) throw notFound(id);
    const secrets = this.deps.secrets();
    return { lines: r.instance.logTail().map((l) => redactSecrets(l, secrets)) };
  }

  async stop(id: string): Promise<void> {
    const r = this.running.get(id);
    if (!r) throw notFound(id);
    this.running.delete(id);
    r.cancel?.();
    try {
      await this.track(r.instance.stop());
    } finally {
      this.deps.onChange();
    }
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.running.keys()].map((id) => this.stop(id).catch(() => undefined)));
    await this.settled();
  }

  /** Resolves once every engine being stopped has gone (LLM Bench quitting waits for this). */
  async settled(): Promise<void> {
    while (this.stopping.size) await Promise.all([...this.stopping]);
  }

  private track<T>(p: Promise<T>): Promise<T> {
    const done: Promise<void> = p.then(
      () => void this.stopping.delete(done),
      () => void this.stopping.delete(done),
    );
    this.stopping.add(done);
    return p;
  }
}
