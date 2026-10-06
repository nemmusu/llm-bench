import { promises as fs } from 'node:fs';
import path from 'node:path';
import { AppError } from '../../contract/errors';
import type { LocalModel } from '../../contract/models';
import type { Clock, Logger } from '../deps';
import type { DockerCli } from './cli';
import type { ImageService } from './images';

/**
 * "Copia il modello nello spazio Docker": on Windows (and macOS) Docker Desktop reads host folders
 * through its VM file share, which makes model loads several times slower than on a real disk. A
 * one-time copy into a named volume removes that, so Docker loads measure the engine, not the share.
 *
 * One volume per model (gpubench-model-<localId>), files at its root, labelled as ours. The copy runs
 * in a tiny helper container with explicit arguments (no shell), and progress is read with `du`.
 */
export const MODEL_VOLUME_PREFIX = 'gpubench-model-';
export const HELPER_IMAGE = 'busybox:stable';
const ID_RE = /^[a-z0-9-]{1,64}$/;

export function modelVolumeName(localId: string): string {
  if (!ID_RE.test(localId)) throw new AppError('VALIDATION', 'Invalid model id', { params: { id: localId } });
  return `${MODEL_VOLUME_PREFIX}${localId}`;
}

/** Bytes reported by `du -sb <dir>` ("12345\t/dst"). */
export function parseDuBytes(stdout: string): number | undefined {
  const n = Number(stdout.trim().split(/\s+/)[0]);
  return Number.isFinite(n) && stdout.trim() !== '' ? n : undefined;
}

export interface ModelVolumesOptions {
  cli: DockerCli;
  images: Pick<ImageService, 'pull'>;
  clock: Clock;
  log?: Logger;
  pollMs?: number;
  stat?: (p: string) => Promise<{ size: number }>;
}

export interface CopyProgress {
  bytesDone: number;
  bytesTotal: number;
}

export class ModelVolumes {
  private readonly stat: (p: string) => Promise<{ size: number }>;

  constructor(private readonly o: ModelVolumesOptions) {
    this.stat = o.stat ?? ((p) => fs.stat(p));
  }

  /** Local model ids that have a volume copy. */
  async list(): Promise<string[]> {
    const r = await this.o.cli.exec(['volume', 'ls', '--filter', 'label=gpubench.model', '--format', '{{.Name}}'], { timeoutMs: 20_000 });
    if (r.code !== 0) return [];
    return r.stdout
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.startsWith(MODEL_VOLUME_PREFIX))
      .map((l) => l.slice(MODEL_VOLUME_PREFIX.length));
  }

  async exists(localId: string): Promise<boolean> {
    const r = await this.o.cli.exec(['volume', 'inspect', modelVolumeName(localId)], { timeoutMs: 20_000 });
    return r.code === 0;
  }

  async copy(model: LocalModel, onProgress: (p: CopyProgress) => void, signal: AbortSignal): Promise<string> {
    const volume = modelVolumeName(model.id);
    const aux = new Set(model.auxiliary.map((a) => a.path));
    const files = model.paths.filter((p) => !aux.has(p));
    const first = files[0];
    if (first === undefined) throw new AppError('MODEL_NOT_FOUND', 'No model files to copy', { params: { id: model.id } });
    const dir = path.dirname(first);
    const sizes = await Promise.all(files.map((f) => this.stat(f).then((s) => s.size)));
    const bytesTotal = sizes.reduce((a, b) => a + b, 0);
    onProgress({ bytesDone: 0, bytesTotal });

    if (!(await this.o.cli.imageInspect(HELPER_IMAGE))) await this.o.images.pull(HELPER_IMAGE, () => {}, signal);
    const created = await this.o.cli.exec(
      ['volume', 'create', '--label', 'gpubench=1', '--label', `gpubench.model=${model.id}`, volume],
      { timeoutMs: 30_000 },
    );
    if (created.code !== 0) throw new AppError('DOCKER_VOLUME_FAILED', 'Could not create the model volume', { detail: created.stderr });

    const copy = await this.o.cli.spawn(
      ['run', '--rm', '--label', 'gpubench=1', '-v', `${dir}:/src:ro`, '-v', `${volume}:/dst`, HELPER_IMAGE, 'cp', ...files.map((f) => `/src/${path.basename(f)}`), '/dst/'],
      { runId: 'volume-copy', marker: volume },
    );
    const onAbort = () => void copy.stop({ graceMs: 0 });
    signal.addEventListener('abort', onAbort, { once: true });
    let done = false;
    const poll = (async () => {
      while (!done) {
        await this.o.clock.sleep(this.o.pollMs ?? 1500);
        if (done) break;
        const du = await this.o.cli.exec(['run', '--rm', '-v', `${volume}:/dst:ro`, HELPER_IMAGE, 'du', '-sb', '/dst'], { timeoutMs: 30_000 });
        const bytes = du.code === 0 ? parseDuBytes(du.stdout) : undefined;
        if (bytes !== undefined && !done) onProgress({ bytesDone: Math.min(bytes, bytesTotal), bytesTotal });
      }
    })();
    const exit = await copy.exited;
    done = true;
    signal.removeEventListener('abort', onAbort);
    await poll;
    if (signal.aborted || exit.code !== 0) {
      await this.o.cli.exec(['volume', 'rm', '-f', volume], { timeoutMs: 30_000 });
      if (signal.aborted) throw new AppError('CANCELLED', 'Copy cancelled');
      throw new AppError('DOCKER_VOLUME_FAILED', 'Copying the model into Docker failed', { params: { code: exit.code ?? -1 } });
    }
    onProgress({ bytesDone: bytesTotal, bytesTotal });
    this.o.log?.info('model copied into a Docker volume', { volume, bytes: bytesTotal });
    return volume;
  }

  async remove(localId: string): Promise<void> {
    const r = await this.o.cli.exec(['volume', 'rm', '-f', modelVolumeName(localId)], { timeoutMs: 30_000 });
    if (r.code !== 0) throw new AppError('DOCKER_VOLUME_FAILED', 'Could not remove the model volume', { detail: r.stderr });
  }
}
