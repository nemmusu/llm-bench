import { AppError } from '../../contract/errors';

/** One JSON line of POST /images/create (same format for the classic and the containerd image store). */
export interface PullMessage {
  status?: string;
  id?: string;
  progressDetail?: { current?: number; total?: number };
  progress?: string;
  error?: string;
  errorDetail?: { message?: string; code?: number };
}

export interface PullProgress {
  status: 'resolving' | 'downloading' | 'extracting' | 'done';
  bytesDone: number;
  /** Sum of the layer sizes known so far (a layer's size is known once its download starts). */
  bytesTotal: number;
  layersDone: number;
  layersTotal: number;
}

interface Layer {
  total: number;
  current: number;
  downloaded: boolean;
  done: boolean;
}

/**
 * Aggregates per-layer messages into one progress figure. Layers already present locally count as
 * done with zero bytes, so bytesTotal is what actually has to be downloaded.
 */
export class PullAggregator {
  private readonly layers = new Map<string, Layer>();
  private finished = false;
  digest: string | undefined;

  /** Applies one message; throws DOCKER_PULL_FAILED (or DISK_FULL) for an error message. */
  push(m: PullMessage): PullProgress {
    const err = m.errorDetail?.message ?? m.error;
    if (err !== undefined) throw pullError(err);
    const status = m.status ?? '';
    const digest = /^Digest: (\S+)/.exec(status)?.[1];
    if (digest !== undefined) this.digest = digest;
    if (/^Status: /.test(status)) this.finished = true;
    // "Pulling from <repo>" carries the tag as id: not a layer.
    if (m.id !== undefined && !/^Pulling from /.test(status) && status !== '') this.layer(m.id, status, m.progressDetail);
    return this.snapshot();
  }

  private layer(id: string, status: string, detail: PullMessage['progressDetail']): void {
    let l = this.layers.get(id);
    if (!l) {
      l = { total: 0, current: 0, downloaded: false, done: false };
      this.layers.set(id, l);
    }
    if (status === 'Downloading' && detail?.total !== undefined && detail.total > 0) {
      l.total = detail.total;
      l.current = Math.min(detail.current ?? 0, detail.total);
    } else if (status === 'Download complete' || status === 'Verifying Checksum' || /^Extracting/.test(status)) {
      l.downloaded = true;
      l.current = l.total;
    } else if (status === 'Pull complete' || status === 'Already exists') {
      l.downloaded = true;
      l.current = l.total;
      l.done = true;
    } else if (/^Retrying/.test(status)) {
      l.current = 0;
    }
  }

  snapshot(): PullProgress {
    let bytesDone = 0;
    let bytesTotal = 0;
    let layersDone = 0;
    let downloading = false;
    for (const l of this.layers.values()) {
      bytesDone += l.current;
      bytesTotal += l.total;
      if (l.done) layersDone++;
      if (!l.downloaded) downloading = true;
    }
    const layersTotal = this.layers.size;
    const status: PullProgress['status'] = this.finished
      ? 'done'
      : layersTotal === 0
        ? 'resolving'
        : downloading
          ? 'downloading'
          : 'extracting';
    return { status, bytesDone, bytesTotal, layersDone, layersTotal };
  }

  get done(): boolean {
    return this.finished;
  }
}

/** Why a pull failed, from the daemon's message. */
export function pullFailureReason(message: string): 'not-found' | 'auth' | 'rate-limited' | 'network' | 'other' {
  if (/manifest unknown|not found|no such image|repository does not exist/i.test(message)) return 'not-found';
  if (/toomanyrequests|rate limit/i.test(message)) return 'rate-limited';
  if (/denied|unauthorized|authentication required|no basic auth credentials/i.test(message)) return 'auth';
  if (/timeout|timed out|connection reset|no such host|TLS handshake|EOF|network is unreachable|dial tcp/i.test(message)) {
    return 'network';
  }
  return 'other';
}

export function pullError(message: string, image?: string): AppError {
  const params: Record<string, string> = { reason: pullFailureReason(message) };
  if (image !== undefined) params.image = image;
  if (/no space left on device/i.test(message)) {
    return new AppError('DISK_FULL', 'No space left for the Docker image', { params, detail: message });
  }
  return new AppError('DOCKER_PULL_FAILED', `Image pull failed: ${message}`, { params, detail: message });
}
