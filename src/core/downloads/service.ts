import { randomUUID } from 'node:crypto';
import { rm, stat, statfs } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { DownloadRequest } from '../../contract/api';
import { AppError, toAppErrorData } from '../../contract/errors';
import type { ServerEvent } from '../../contract/events';
import { downloadJobSchema, type DownloadJob, type HubFile } from '../../contract/models';
import type { Clock, Logger } from '../deps';
import type { HubClient } from '../models/hub';
import { REPO_RE, repoDir, safeRepoPath } from '../models/paths';
import { DOWNLOAD_SIDECAR, readSidecar, type DownloadSidecar } from '../models/scanner';
import { readJsonFile, writeFileAtomic } from '../store/atomic';
import { downloadFile } from './downloader';

export interface DownloadServiceOptions {
  fetch: typeof fetch;
  clock: Clock;
  log: Logger;
  /** downloads.json lives here. */
  dataDir: string;
  /** Library folder (settings.modelsDir or the default). */
  modelsDir: () => Promise<string>;
  hub: Pick<HubClient, 'files' | 'authHeaders' | 'resolveUrl'>;
  /** Emits 'download.update' events (EventHub.publish). */
  publish: (e: ServerEvent) => void;
  /** Called after a job completes (the lead wires a model rescan here). */
  onComplete?: (job: DownloadJob) => void | Promise<void>;
  statfs?: (dir: string) => Promise<{ bavail: number | bigint; bsize: number | bigint }>;
  /** Core shutdown: running jobs stop and are saved as paused. */
  signal?: AbortSignal;
  maxParallel?: number;
  maxRetries?: number;
  backoffMs?: number;
  /** Minimum ms between progress events of one job (default 250 → at most 4/s). */
  throttleMs?: number;
  newId?: () => string;
}

const STATE_FILE = 'downloads.json';
const FINISHED: DownloadJob['state'][] = ['done', 'failed', 'cancelled'];
const KEEP_FINISHED = 50;
/** Head-room kept free on the disk beyond the bytes still to download. */
const DISK_MARGIN = 256 * 1024 * 1024;
const SPEED_WINDOW_MS = 500;
const EWMA_ALPHA = 0.3;

const persistedSchema = z.object({
  version: z.literal(1),
  jobs: z.array(z.object({ job: downloadJobSchema, revision: z.string(), done: z.array(z.string()), commit: z.string().optional() })),
});

interface JobRecord {
  job: DownloadJob;
  revision: string;
  done: string[];
  commit?: string;
  abort?: AbortController;
  intent?: 'pause' | 'cancel' | 'shutdown';
  running?: Promise<void>;
  doneBytes: number;
  lastPublish: number;
  timer?: ReturnType<typeof setTimeout>;
  speedT?: number;
  speedBytes?: number;
}

/** Files of a safetensors repo vLLM needs: everything except other formats and originals. */
export function vllmRepoFiles(files: HubFile[]): string[] {
  const hasSafetensors = files.some((f) => f.path.endsWith('.safetensors'));
  return files
    .map((f) => f.path)
    .filter((p) => {
      const lower = p.toLowerCase();
      if (/\.(gguf|pth|pt|onnx|msgpack|h5|ot|tflite|mlmodel)$/.test(lower)) return false;
      if (/^(original|onnx|openvino|coreml)\//.test(lower)) return false;
      return !(hasSafetensors && /(^|\/)pytorch_model.*\.bin$/.test(lower));
    });
}

/**
 * Download queue: at most `maxParallel` jobs run, each job fetches its files in order. State is
 * persisted to <dataDir>/downloads.json so jobs survive restarts (a job that was running comes
 * back paused; queued jobs start again).
 *
 * Destination layout (one folder per repo, so the scanner can infer the repo id; see models/paths
 * repoDir/libraryPath):
 *   GGUF        → <modelsDir>/<owner>/<repo>/<file path in repo>   (split shards side by side)
 *   safetensors → <modelsDir>/<owner>/<repo>/…  the whole repo minus *.gguf, original/, *.pth
 *                 (vllmRepoFiles); vLLM loads that folder directly.
 * A sidecar <repo folder>/.gpubench-download.json records repo, commit and the verified sha256
 * of each file, so the library knows them without re-hashing.
 */
export class DownloadService {
  private readonly records = new Map<string, JobRecord>();
  private saving: Promise<void> = Promise.resolve();
  private readonly maxParallel: number;
  private readonly throttleMs: number;
  private readonly stateFile: string;

  constructor(private readonly opts: DownloadServiceOptions) {
    this.maxParallel = opts.maxParallel ?? 2;
    this.throttleMs = opts.throttleMs ?? 250;
    this.stateFile = path.join(opts.dataDir, STATE_FILE);
    opts.signal?.addEventListener('abort', () => {
      for (const r of this.records.values()) void this.stop(r, 'shutdown');
    });
  }

  /** Loads persisted jobs and restarts queued ones. Call once at startup. */
  async init(): Promise<void> {
    const raw = await readJsonFile(this.stateFile).catch(() => undefined);
    const parsed = persistedSchema.safeParse(raw);
    if (!parsed.success) return;
    for (const p of parsed.data.jobs) {
      const job = p.job;
      if (job.state === 'running' || job.state === 'verifying') job.state = 'paused';
      job.bytesTotal ??= job.files.reduce((a, f) => a + sizeOf(f), 0);
      job.bytesPerSec = undefined;
      job.etaSec = undefined;
      const rec: JobRecord = { job, revision: p.revision, done: p.done, doneBytes: 0, lastPublish: -Infinity, ...(p.commit ? { commit: p.commit } : {}) };
      rec.doneBytes = this.doneBytesOf(rec);
      job.bytesDone = rec.doneBytes + (await this.partBytes(rec));
      this.records.set(job.id, rec);
    }
    this.schedule();
  }

  list(): DownloadJob[] {
    return [...this.records.values()].map((r) => this.snapshot(r));
  }

  async add(req: DownloadRequest): Promise<DownloadJob> {
    if (!REPO_RE.test(req.repo)) throw new AppError('VALIDATION', 'Invalid repo id', { params: { repo: req.repo } });
    const revision = req.revision;
    const wantsAll = req.files.includes('*');
    if (!wantsAll && !req.files.every(safeRepoPath)) throw new AppError('VALIDATION', 'Invalid file path in request');
    const listing = await this.opts.hub.files(req.repo, revision);
    const byPath = new Map(listing.map((f) => [f.path, f]));
    const paths = wantsAll ? vllmRepoFiles(listing) : [...new Set(req.files)];
    const missing = paths.find((p) => !byPath.has(p));
    if (missing !== undefined) throw new AppError('HF_NOT_FOUND', `File not in repo: ${missing}`, { params: { repo: req.repo, file: missing } });
    if (paths.length === 0) throw new AppError('VALIDATION', 'Nothing to download');
    const same = [...this.records.values()].find(
      (r) => !FINISHED.includes(r.job.state) && r.job.repo === req.repo && r.job.files.map((f) => f.path).sort().join('\n') === [...paths].sort().join('\n'),
    );
    if (same) return this.snapshot(same);

    const files = paths.map((p) => {
      const f = byPath.get(p) as HubFile;
      return { path: p, sizeBytes: f.sizeBytes, ...(f.sha256 ? { sha256: f.sha256 } : {}) };
    });
    const job: DownloadJob = {
      id: this.opts.newId?.() ?? randomUUID(),
      label: req.label ?? (paths.length === 1 ? `${req.repo} · ${path.posix.basename(paths[0] as string)}` : req.repo),
      repo: req.repo,
      files,
      dest: repoDir(await this.opts.modelsDir(), req.repo),
      state: 'queued',
      bytesDone: 0,
      bytesTotal: files.reduce((a, f) => a + f.sizeBytes, 0),
      createdAt: new Date(this.opts.clock.wall()).toISOString(),
    };
    const rec: JobRecord = { job, revision, done: [], doneBytes: 0, lastPublish: -Infinity };
    this.records.set(job.id, rec);
    this.emit(rec, true);
    await this.persist();
    this.schedule();
    return this.snapshot(rec);
  }

  async pause(id: string): Promise<DownloadJob> {
    const rec = this.get(id);
    if (rec.job.state === 'queued') this.setState(rec, 'paused');
    else if (rec.running) await this.stop(rec, 'pause');
    else if (rec.job.state !== 'paused') throw new AppError('VALIDATION', `Cannot pause a ${rec.job.state} download`, { params: { id } });
    await this.persist();
    return this.snapshot(rec);
  }

  async resume(id: string): Promise<DownloadJob> {
    const rec = this.get(id);
    if (rec.job.state === 'paused' || rec.job.state === 'failed') {
      delete rec.job.error;
      this.setState(rec, 'queued');
      await this.persist();
      this.schedule();
    } else if (rec.job.state !== 'queued' && !rec.running) {
      throw new AppError('VALIDATION', `Cannot resume a ${rec.job.state} download`, { params: { id } });
    }
    return this.snapshot(rec);
  }

  async cancel(id: string): Promise<DownloadJob> {
    const rec = this.get(id);
    if (rec.job.state === 'done' || rec.job.state === 'cancelled') throw new AppError('VALIDATION', `Cannot cancel a ${rec.job.state} download`, { params: { id } });
    if (rec.running) await this.stop(rec, 'cancel');
    else {
      await this.removeParts(rec);
      this.setState(rec, 'cancelled');
    }
    await this.persist();
    return this.snapshot(rec);
  }

  /** Resolves when no job is running (tests, shutdown). */
  async idle(): Promise<void> {
    for (;;) {
      const running = [...this.records.values()].map((r) => r.running).filter((p): p is Promise<void> => p !== undefined);
      if (running.length === 0) return;
      await Promise.all(running);
    }
  }

  // ---- internals --------------------------------------------------------------------------------

  private get(id: string): JobRecord {
    const rec = this.records.get(id);
    if (!rec) throw new AppError('DOWNLOAD_NOT_FOUND', `Unknown download ${id}`, { params: { id } });
    return rec;
  }

  private snapshot(rec: JobRecord): DownloadJob {
    return structuredClone(rec.job);
  }

  private async stop(rec: JobRecord, intent: NonNullable<JobRecord['intent']>): Promise<void> {
    if (!rec.running) return;
    rec.intent = intent;
    rec.abort?.abort();
    await rec.running;
  }

  private schedule(): void {
    if (this.opts.signal?.aborted) return;
    let running = [...this.records.values()].filter((r) => r.running).length;
    for (const rec of this.records.values()) {
      if (running >= this.maxParallel) break;
      if (rec.job.state !== 'queued' || rec.running) continue;
      running++;
      rec.running = this.run(rec).finally(() => {
        rec.running = undefined;
        this.schedule();
      });
    }
  }

  private async run(rec: JobRecord): Promise<void> {
    const { job } = rec;
    rec.abort = new AbortController();
    rec.intent = undefined;
    rec.speedT = undefined;
    this.setState(rec, 'running');
    try {
      await this.checkDiskSpace(rec);
      for (const f of job.files) {
        if (rec.done.includes(f.path)) continue;
        const dest = path.join(job.dest, ...f.path.split('/'));
        const existing = await stat(dest).catch(() => undefined);
        // Already downloaded (and verified) by an earlier job.
        if (!existing || existing.size !== f.sizeBytes) {
          const result = await downloadFile({
            fetch: this.opts.fetch,
            url: this.opts.hub.resolveUrl(job.repo as string, rec.revision, f.path),
            dest,
            expectedSize: f.sizeBytes,
            ...(f.sha256 ? { expectedSha256: f.sha256 } : {}),
            authHeaders: (u) => this.opts.hub.authHeaders(u),
            signal: rec.abort.signal,
            onProgress: (bytes) => this.progress(rec, bytes),
            onPhase: (phase) => this.setState(rec, phase === 'verifying' ? 'verifying' : 'running'),
            onCommit: (sha) => {
              rec.commit = sha;
            },
            sleep: (ms, signal) => this.opts.clock.sleep(ms, signal),
            ...(this.opts.maxRetries !== undefined ? { maxRetries: this.opts.maxRetries } : {}),
            ...(this.opts.backoffMs !== undefined ? { backoffMs: this.opts.backoffMs } : {}),
            repo: job.repo as string,
          });
          await this.writeSidecar(rec, f.path, result.sha256, result.bytes);
        }
        rec.done.push(f.path);
        rec.doneBytes += sizeOf(f);
        job.bytesDone = rec.doneBytes;
        await this.persist();
      }
      job.bytesDone = job.bytesTotal as number;
      this.setState(rec, 'done');
      await this.persist();
      try {
        await this.opts.onComplete?.(this.snapshot(rec));
      } catch (e) {
        this.opts.log.warn('download completion hook failed', { error: (e as Error).message });
      }
    } catch (e) {
      if (rec.intent === 'cancel') {
        await this.removeParts(rec);
        this.setState(rec, 'cancelled');
      } else if (rec.intent) {
        this.setState(rec, 'paused');
      } else {
        job.error = { ...pick(toAppErrorData(e)) };
        this.setState(rec, 'failed');
        this.opts.log.warn('download failed', { id: job.id, repo: job.repo, code: job.error.code });
      }
      await this.persist();
    }
  }

  private async checkDiskSpace(rec: JobRecord): Promise<void> {
    const remaining = (rec.job.bytesTotal as number) - rec.doneBytes - (await this.partBytes(rec));
    let dir = rec.job.dest;
    while (!(await stat(dir).catch(() => undefined)) && path.dirname(dir) !== dir) dir = path.dirname(dir);
    const fsInfo = await (this.opts.statfs ?? statfs)(dir);
    const free = Number(fsInfo.bavail) * Number(fsInfo.bsize);
    if (free < remaining + DISK_MARGIN) {
      throw new AppError('DISK_FULL', 'Not enough free disk space for this download', { params: { needBytes: remaining, freeBytes: free, dir } });
    }
  }

  private doneBytesOf(rec: JobRecord): number {
    return rec.job.files.filter((f) => rec.done.includes(f.path)).reduce((a, f) => a + sizeOf(f), 0);
  }

  private async partBytes(rec: JobRecord): Promise<number> {
    let total = 0;
    for (const f of rec.job.files) {
      if (rec.done.includes(f.path)) continue;
      total += (await stat(path.join(rec.job.dest, ...f.path.split('/')) + '.part').catch(() => undefined))?.size ?? 0;
    }
    return total;
  }

  private async removeParts(rec: JobRecord): Promise<void> {
    for (const f of rec.job.files) await rm(path.join(rec.job.dest, ...f.path.split('/')) + '.part', { force: true });
    rec.job.bytesDone = rec.doneBytes;
  }

  private async writeSidecar(rec: JobRecord, file: string, sha256: string, bytes: number): Promise<void> {
    const existing = await readSidecar(rec.job.dest);
    const sidecar: DownloadSidecar = {
      repo: rec.job.repo as string,
      revision: rec.commit ?? existing?.revision ?? rec.revision,
      files: { ...(existing?.files ?? {}), [file]: { sha256, sizeBytes: bytes } },
    };
    await writeFileAtomic(path.join(rec.job.dest, DOWNLOAD_SIDECAR), JSON.stringify(sidecar, null, 2));
  }

  /** Progress of the current file → job bytes, EWMA speed and ETA; throttled event. */
  private progress(rec: JobRecord, fileBytes: number): void {
    const { job } = rec;
    job.bytesDone = rec.doneBytes + fileBytes;
    const now = this.opts.clock.now();
    if (rec.speedT === undefined) {
      rec.speedT = now;
      rec.speedBytes = job.bytesDone;
    } else if (now - rec.speedT >= SPEED_WINDOW_MS) {
      const inst = ((job.bytesDone - (rec.speedBytes as number)) * 1000) / (now - rec.speedT);
      job.bytesPerSec = job.bytesPerSec === undefined ? inst : EWMA_ALPHA * inst + (1 - EWMA_ALPHA) * job.bytesPerSec;
      if (job.bytesPerSec > 0) job.etaSec = Math.max(0, ((job.bytesTotal as number) - job.bytesDone) / job.bytesPerSec);
      rec.speedT = now;
      rec.speedBytes = job.bytesDone;
    }
    this.emit(rec, false);
  }

  private setState(rec: JobRecord, state: DownloadJob['state']): void {
    rec.job.state = state;
    if (state !== 'running' && state !== 'verifying') {
      rec.job.bytesPerSec = undefined;
      rec.job.etaSec = undefined;
    }
    this.emit(rec, true);
  }

  /** Publishes now (state changes) or at most once per throttle window, with a trailing update. */
  private emit(rec: JobRecord, force: boolean): void {
    const now = this.opts.clock.now();
    if (force || now - rec.lastPublish >= this.throttleMs) {
      if (rec.timer) clearTimeout(rec.timer);
      rec.timer = undefined;
      rec.lastPublish = now;
      this.opts.publish({ type: 'download.update', job: this.snapshot(rec) });
      return;
    }
    rec.timer ??= setTimeout(() => {
      rec.timer = undefined;
      this.emit(rec, true);
    }, this.throttleMs - (now - rec.lastPublish));
  }

  private persist(): Promise<void> {
    const all = [...this.records.values()];
    const finished = all.filter((r) => FINISHED.includes(r.job.state));
    const keep = new Set(finished.slice(-KEEP_FINISHED));
    const jobs = all
      .filter((r) => !FINISHED.includes(r.job.state) || keep.has(r))
      .map((r) => ({ job: r.job, revision: r.revision, done: r.done, ...(r.commit ? { commit: r.commit } : {}) }));
    const json = JSON.stringify({ version: 1, jobs });
    this.saving = this.saving
      .then(() => writeFileAtomic(this.stateFile, json))
      .catch((e: unknown) => this.opts.log.warn('cannot save downloads state', { error: (e as Error).message }));
    return this.saving;
  }
}

/** Persisted jobs may lack sizes (older files); count them as 0. */
function sizeOf(f: DownloadJob['files'][number]): number {
  return f.sizeBytes ?? 0;
}

function pick(e: { code: string; message: string }): { code: string; message: string } {
  return { code: e.code, message: e.message };
}
