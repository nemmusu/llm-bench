/**
 * "Avvia Docker" and "Riavvia Docker" for every screen and for the tray, the watchdog that notices
 * when Docker stops answering while our servers or a test use it, and our servers Docker took down
 * ("Riavvia i server che erano attivi"). Progress goes out as 'engine.install' events
 * ('docker-desktop' for a start, 'docker-restart' for a restart), state changes as 'docker.changed'.
 * Only containers LLM Bench started (label gpubench=1, through ServeService) are ever touched.
 */
import type { ServerInfo, StartServerRequest } from '../../contract/api';
import type { DockerLostServer, DockerRecovery, DockerRestartResult, DockerRestartStage } from '../../contract/docker';
import { isDockerKind } from '../../contract/engines';
import { toAppErrorData } from '../../contract/errors';
import type { ServerEvent } from '../../contract/events';
import type { ServerNotice, ShellDocker } from '../../contract/servers';
import type { Clock, Logger } from '../deps';
import type { DockerEnvironment, DockerStatusDetail } from './environment';

/** The parts of ServeService the recovery needs. */
export interface DockerServers {
  list(): ServerInfo[];
  start(req: StartServerRequest, signal: AbortSignal): Promise<ServerInfo>;
  stop(id: string): Promise<void>;
}

export interface DockerControlDeps {
  env: DockerEnvironment;
  publish(e: ServerEvent): void;
  servers: DockerServers;
  /** A server that did not start again becomes a notice on the Server page. */
  notices?: { add(kind: ServerNotice['kind'], preset: { id?: string; name: string }, error: unknown): void };
  /** A Docker benchmark is running: its container keeps the watchdog awake too. */
  dockerRunActive?: () => boolean;
  /** A benchmark is running: unless it uses Docker, the watchdog leaves the PC alone meanwhile. */
  measuring?: () => boolean;
  /** Forgets the Engine API endpoint chosen before a start or restart. */
  resetApi?: () => void;
  clock: Clock;
  log: Logger;
  shutdown: AbortSignal;
  /** Watchdog period while Docker is in use or changing (default 20 s), otherwise (default 60 s). */
  activeEveryMs?: number;
  idleEveryMs?: number;
}

/** A Docker server to start again: what the user sees, and the request it was started with. */
interface LostServer extends DockerLostServer {
  request: StartServerRequest;
}

type InstallEvent = Extract<ServerEvent, { type: 'engine.install' }>;
type RestartEvent = Omit<InstallEvent, 'type' | 'kind' | 'stage'> & { stage: DockerRestartStage };

const lostOf = (s: ServerInfo): LostServer => ({
  id: s.id,
  name: s.presetName ?? s.modelLabel,
  port: s.port,
  ...(s.presetId !== undefined ? { presetId: s.presetId } : {}),
  request: s.request,
});

const UP = new Set<DockerStatusDetail['state']>(['running', 'no-gpu']);

export class DockerControl {
  private startJob: Promise<void> | undefined;
  private restartJob: Promise<void> | undefined;
  private restoreJob: Promise<DockerRestartResult> | undefined;
  /** Our servers Docker took down, oldest first. */
  private lost: LostServer[] = [];
  /** Servers whose end is expected (a restart is taking them down): not "lost". */
  private readonly expected = new Set<string>();
  /** The tray was told this time Docker got stuck. */
  private stuckTold = false;
  private readonly listeners = new Set<() => void>();
  private readonly stuckListeners = new Set<() => void>();

  constructor(private readonly o: DockerControlDeps) {
    o.env.onChange((s) => {
      o.publish({ type: 'docker.changed', state: s.state });
      if (s.state !== 'not-responding') this.stuckTold = false;
      this.changed();
    });
  }

  /** Called whenever what the tray shows about Docker may have changed. Returns the unsubscribe. */
  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Called once each time Docker gets stuck while it is in use (the tray's notification). */
  onStuck(fn: () => void): () => void {
    this.stuckListeners.add(fn);
    return () => this.stuckListeners.delete(fn);
  }

  private changed(): void {
    for (const fn of this.listeners) fn();
  }

  /** Docker as the tray shows it; undefined until its state is known. */
  shell(): ShellDocker | undefined {
    const s = this.o.env.peek();
    if (!s) return undefined;
    const busy = this.restartJob ? 'restarting' : this.startJob ? 'starting' : undefined;
    return { state: s.state, ...(busy ? { busy } : {}), control: this.o.env.platform === 'win32' };
  }

  /** "Avvia Docker": at once; progress as 'engine.install' events of kind 'docker-desktop'. false = one is under way already. */
  start(): boolean {
    if (this.startJob || this.restartJob) return false;
    const emit = (e: Omit<InstallEvent, 'type' | 'kind'>) => this.o.publish({ type: 'engine.install', kind: 'docker-desktop', ...e });
    this.startJob = this.o.env
      .startDesktop(this.o.shutdown, (p) => emit({ stage: 'starting', bytesDone: p.elapsedMs, state: p.state, slow: p.slow }))
      .then(
        (r) => {
          this.o.resetApi?.();
          emit({ stage: 'running', bytesDone: 0, state: r.state });
        },
        (e: unknown) => emit({ stage: 'error', bytesDone: 0, error: toAppErrorData(e) }),
      )
      .finally(() => {
        this.startJob = undefined;
        this.changed();
      });
    this.changed();
    return true;
  }

  /**
   * "Riavvia Docker": at once; progress as 'engine.install' events of kind 'docker-restart'. Our
   * Docker servers running now (and the ones Docker took down before) are started again afterwards,
   * with the same request. false = a restart is under way already.
   */
  restart(opts: { deep?: boolean } = {}): boolean {
    if (this.restartJob) return false;
    const running = this.o.servers.list().filter((s) => isDockerKind(s.engineKind)).map(lostOf);
    for (const s of running) this.expected.add(s.id);
    const toRestore = [...this.lost.filter((l) => !running.some((r) => r.id === l.id)), ...running];
    const extra = toRestore.length ? 1 : 0;
    const emit = (e: RestartEvent) => this.o.publish({ type: 'engine.install', kind: 'docker-restart', ...e });
    this.restartJob = (async () => {
      let steps = 0;
      try {
        const r = await this.o.env.restartDesktop(
          this.o.shutdown,
          (p) => {
            steps = p.steps + extra;
            emit({ stage: p.step, step: p.index, steps, bytesDone: p.elapsedMs, state: p.state, slow: p.slow });
          },
          { deep: opts.deep === true },
        );
        this.o.resetApi?.();
        this.lost = toRestore;
        const result = await this.restoreAll(emit, steps);
        emit({ stage: 'running', bytesDone: 0, state: r.state, result });
      } catch (e) {
        // Whatever was running is down now: offer it again once Docker is back.
        this.addLost(running);
        emit({ stage: 'error', bytesDone: 0, error: toAppErrorData(e) });
      } finally {
        for (const s of running) this.expected.delete(s.id);
        this.restartJob = undefined;
        this.changed();
      }
    })();
    this.changed();
    return true;
  }

  /** "Riavvia i server che erano attivi". false = nothing to do, or it is under way already. */
  restore(): boolean {
    if (this.restoreJob || this.restartJob || this.lost.length === 0) return false;
    const emit = (e: RestartEvent) => this.o.publish({ type: 'engine.install', kind: 'docker-restart', ...e });
    void this.restoreAll(emit, 1).then((result) => emit({ stage: 'running', bytesDone: 0, result }));
    return true;
  }

  /** The servers Docker took down, and whether they are being started again. */
  recovery(): DockerRecovery {
    return { servers: this.lost.map(({ request: _r, ...s }) => s), restoring: this.restoreJob !== undefined };
  }

  /** "Non ora": forgets them. */
  forget(): void {
    this.lost = [];
    this.publishState();
  }

  /** Lets the UI read the recovery again (no state change of its own). */
  private publishState(): void {
    const s = this.o.env.peek();
    if (s) this.o.publish({ type: 'docker.changed', state: s.state });
  }

  private addLost(list: readonly LostServer[]): void {
    for (const s of list) if (!this.lost.some((l) => l.id === s.id)) this.lost.push(s);
  }

  /** Starts the lost servers again, one after the other (each needs the GPU); failures become notices. */
  private restoreAll(emit: (e: RestartEvent) => void, steps: number): Promise<DockerRestartResult> {
    const list = [...this.lost];
    const run = async (): Promise<DockerRestartResult> => {
      const result: DockerRestartResult = { restored: [], failed: [] };
      for (const [i, s] of list.entries()) {
        emit({ stage: 'servers', step: steps, steps, bytesDone: i, bytesTotal: list.length, label: s.name });
        try {
          this.expected.add(s.id);
          // Still listed: its container died with Docker but its log follower has not noticed yet.
          if (this.o.servers.list().some((x) => x.id === s.id)) await this.o.servers.stop(s.id).catch(() => undefined);
          await this.o.servers.start(s.request, this.o.shutdown);
          result.restored.push(s.name);
        } catch (e) {
          result.failed.push(s.name);
          this.o.notices?.add('docker-restore-failed', { ...(s.presetId !== undefined ? { id: s.presetId } : {}), name: s.name }, e);
          this.o.log.warn('server not started again after Docker came back', { name: s.name, error: toAppErrorData(e).code });
        } finally {
          this.expected.delete(s.id);
        }
      }
      this.lost = this.lost.filter((l) => !list.some((x) => x.id === l.id));
      return result;
    };
    this.restoreJob = run().finally(() => {
      this.restoreJob = undefined;
      this.publishState();
    });
    this.publishState();
    return this.restoreJob;
  }

  /**
   * ServeService: one of our servers ended on its own. A Docker one that ended while Docker is not
   * there (or not answering) was taken down by Docker: remembered for "Riavvia i server che erano attivi".
   */
  async serverEnded(info: ServerInfo): Promise<void> {
    if (!isDockerKind(info.engineKind) || this.expected.has(info.id)) return;
    const s = await this.o.env.status({ fresh: true }).catch(() => undefined);
    if (s && UP.has(s.state)) return;
    this.addLost([lostOf(info)]);
    this.publishState();
  }

  /** Our servers or a benchmark use Docker right now. */
  inUse(): boolean {
    return this.o.servers.list().some((s) => isDockerKind(s.engineKind)) || this.o.dockerRunActive?.() === true;
  }

  /**
   * One look of the watchdog: while Docker is in use, a real check (Docker Desktop's own status, a
   * call the engine must answer); otherwise the cheap cached status. Tells the tray once when Docker
   * got stuck while in use.
   */
  async tick(): Promise<DockerStatusDetail | undefined> {
    const inUse = this.inUse();
    // A benchmark that does not use Docker is measuring: no docker CLI in the middle of it.
    if (!inUse && this.o.measuring?.() === true) return undefined;
    const s = inUse ? await this.o.env.probe(this.o.shutdown) : await this.o.env.status();
    if (s.state === 'not-responding' && inUse && !this.stuckTold) {
      this.stuckTold = true;
      for (const fn of this.stuckListeners) fn();
    }
    return s;
  }

  /**
   * The watchdog: a look at once (the tray knows Docker's state even with no window open), then every
   * activeEveryMs while Docker is in use or changing, else every idleEveryMs, until shutdown.
   */
  watch(): void {
    const { clock, shutdown } = this.o;
    void (async () => {
      while (!shutdown.aborted) {
        await this.tick().catch((e: unknown) => this.o.log.warn('docker watchdog failed', { error: String(e) }));
        const state = this.o.env.peek()?.state;
        const busy = this.inUse() || state === 'starting' || state === 'not-responding' || this.restartJob !== undefined;
        await clock.sleep(busy ? (this.o.activeEveryMs ?? 20_000) : (this.o.idleEveryMs ?? 60_000), shutdown).catch(() => undefined);
      }
    })();
  }
}
