import { AppError, isAppError } from '../../contract/errors';
import { DockerApi } from './client';
import type { DockerEndpoint } from './endpoint';

export interface ApiProviderOptions {
  /** Candidate endpoints in priority order (resolveDockerEndpoints). */
  resolve: () => Promise<DockerEndpoint[]>;
  create?: (e: DockerEndpoint) => DockerApi;
  pingTimeoutMs?: number;
}

/**
 * Picks the first endpoint that answers /_ping (any HTTP status: Docker Desktop answers 500
 * while starting) and remembers it. reset() forgets it, e.g. after Docker Desktop restarted.
 */
export class DockerApiProvider {
  private chosen: Promise<DockerApi> | undefined;
  private readonly create: (e: DockerEndpoint) => DockerApi;

  constructor(private readonly o: ApiProviderOptions) {
    this.create = o.create ?? ((e) => new DockerApi(e));
  }

  get(): Promise<DockerApi> {
    if (!this.chosen) {
      const p = this.pick();
      this.chosen = p;
      // A failed pick is not cached: the daemon may come up a moment later.
      p.catch(() => {
        if (this.chosen === p) this.chosen = undefined;
      });
    }
    return this.chosen;
  }

  reset(): void {
    this.chosen = undefined;
  }

  private async pick(): Promise<DockerApi> {
    const candidates = await this.o.resolve();
    const usable = candidates.filter((c) => c.kind === 'socket' || !c.tls);
    if (usable.length === 0) {
      throw new AppError('DOCKER_UNSUPPORTED', 'Only TLS Docker endpoints are configured', { params: { reason: 'tls-endpoint' } });
    }
    let permission: AppError | undefined;
    let last: AppError | undefined;
    for (const e of usable) {
      const api = this.create(e);
      try {
        await api.ping({ timeoutMs: this.o.pingTimeoutMs ?? 3000 });
        return api;
      } catch (err) {
        const ae = isAppError(err) ? err : new AppError('DOCKER_NOT_RUNNING', String(err));
        if (ae.code === 'DOCKER_PERMISSION') permission ??= ae;
        last = ae;
      }
    }
    // "Permission denied" on any candidate is more useful than "not running" on the others.
    throw permission ?? (last as AppError);
  }
}
