import { randomUUID } from 'node:crypto';
import { readFile, rm, stat, statfs } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { DownloadRequest } from '../../contract/api';
import { AppError, toAppErrorData } from '../../contract/errors';
import type { ServerEvent } from '../../contract/events';
import { NINFER_SUMS, parseSha256Sums, repoLayout } from '../../contract/formats';
import { downloadJobSchema, type DownloadJob, type DownloadPlan, type HubFile, type LocalFileState } from '../../contract/models';
import type { Clock, Logger } from '../deps';
import { sha256File } from '../models/hash';
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
  /**
   * Folders already holding a copy of this repo (the library's, an added folder), with the ids of the
   * models in each: a request goes where its files already are, or next to the model it names (`into`).
   */
  repoFolders?: (repo: string) => Promise<{ dir: string; modelIds: string[] }[]>;
  /** sha256 of a local file when already known (the hash cache), without hashing it. */
  knownSha?: (file: string, sizeBytes: number, mtimeMs: number) => Promise<string | undefined>;
  /** Hashes a local file whose sha256 is not known (default: sha256File in a worker). */
  hashFile?: (file: string, signal: AbortSignal) => Promise<string>;
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

/**
 * What a "whole model" download of a safetensors repo fetches (files ["*"], for vLLM / SGLang): the
 * runtime files of its root model folder (contract/formats.ts), or of its only variant folder when the
 * root has none. Never GGUF files, other variants, other formats, READMEs, images or videos.
 */
export function vllmRepoFiles(files: HubFile[]): string[] {
  const variants = repoLayout(files).safetensors;
  const v = variants.find((x) => x.dir === '') ?? (variants.length === 1 ? variants[0] : undefined);
  return (v?.files ?? []).map((f) => f.path);
}

/**
 * Download queue: at most `maxParallel` jobs run, each job fetches its files in order. State is
 * persisted to <dataDir>/downloads.json so jobs survive restarts (a job that was running comes
 * back paused; queued jobs start again).
 *
 * Destination layout (one folder per repo, so the scanner can infer the repo id; see models/paths
 * repoDir/libraryPath):
 *   GGUF        → <modelsDir>/<owner>/<repo>/<file path in repo>   (split shards side by side)
 *   safetensors → <modelsDir>/<owner>/<repo>/<variant folder>/…  exactly that folder's runtime files
 *                 (contract/formats.ts); vLLM / SGLang load that folder directly.
 * A sidecar <repo folder>/.gpubench-download.json records repo, commit and the verified sha256
 * of each file, so the library knows them without re-hashing, and the files a job set out to fetch
 * (`planned`), so a download stopped halfway shows as "incompleto (1 di 4 file)" instead of a model.
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
      job.bytesTotal ??= totalOf(job);
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

  /**
   * What a request would do, without starting it: where the files go (the folder already holding them,
   * or next to the model it names), and for each file whether the PC already has it ("Il modello è già
   * sul PC: scarico solo mmproj (0,9 GB)"). A file already there and verified is never fetched again.
   */
  async plan(req: DownloadRequest): Promise<DownloadPlan> {
    const { dest, files } = await this.resolve(req);
    const sum = (states: LocalFileState[]) => files.filter((f) => states.includes(f.local)).reduce((a, f) => a + f.sizeBytes, 0);
    return { repo: req.repo, dest, files, bytesToGet: sum(['get', 'update']), bytesHave: sum(['have', 'check']) };
  }

  async add(req: DownloadRequest): Promise<DownloadJob> {
    const { dest, files: planned } = await this.resolve(req);
    const paths = planned.map((f) => f.path);
    const same = [...this.records.values()].find(
      (r) => !FINISHED.includes(r.job.state) && r.job.repo === req.repo && r.job.files.map((f) => f.path).sort().join('\n') === [...paths].sort().join('\n'),
    );
    if (same) return this.snapshot(same);

    const files = planned.map(({ kind: _, ...f }) => f);
    const job: DownloadJob = {
      id: this.opts.newId?.() ?? randomUUID(),
      label: req.label ?? (paths.length === 1 ? `${req.repo} · ${path.posix.basename(paths[0] as string)}` : req.repo),
      repo: req.repo,
      files,
      dest,
      state: 'queued',
      bytesDone: 0,
      createdAt: new Date(this.opts.clock.wall()).toISOString(),
    };
    job.bytesTotal = totalOf(job);
    const rec: JobRecord = { job, revision: req.revision, done: [], doneBytes: 0, lastPublish: -Infinity };
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
      await this.dropPlanned(rec);
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

  /** The request checked against the repo's listing: its files, where they go and what the PC has of them. */
  private async resolve(req: DownloadRequest): Promise<{ dest: string; files: DownloadPlan['files'] }> {
    if (!REPO_RE.test(req.repo)) throw new AppError('VALIDATION', 'Invalid repo id', { params: { repo: req.repo } });
    const wantsAll = req.files.includes('*');
    if (!wantsAll && !req.files.every(safeRepoPath)) throw new AppError('VALIDATION', 'Invalid file path in request');
    const listing = await this.opts.hub.files(req.repo, req.revision);
    const byPath = new Map(listing.map((f) => [f.path, f]));
    const paths = wantsAll ? vllmRepoFiles(listing) : [...new Set(req.files)];
    const missing = paths.find((p) => !byPath.has(p));
    if (missing !== undefined) throw new AppError('HF_NOT_FOUND', `File not in repo: ${missing}`, { params: { repo: req.repo, file: missing } });
    if (paths.length === 0) throw new AppError('VALIDATION', 'Nothing to download');
    const dest = await this.destFor(req, paths);
    const sidecar = await readSidecar(dest);
    const files: DownloadPlan['files'] = [];
    for (const p of paths) {
      const f = byPath.get(p) as HubFile;
      const want = { path: p, sizeBytes: f.sizeBytes, ...(f.sha256 ? { sha256: f.sha256 } : {}) };
      files.push({ ...want, kind: f.kind, local: (await this.onDisk(dest, sidecar, want)).state });
    }
    return { dest, files };
  }

  /**
   * Where a request's files go: the folder of the model it names; else the copy of the repo already
   * holding most of them; else the repo's existing copy (an mmproj joins its model); else the library.
   */
  private async destFor(req: DownloadRequest, paths: string[]): Promise<string> {
    const library = repoDir(await this.opts.modelsDir(), req.repo);
    const folders = (await this.opts.repoFolders?.(req.repo)) ?? [];
    const named = folders.find((f) => req.into !== undefined && f.modelIds.includes(req.into));
    if (named) return named.dir;
    // The library's copy first, then the added folders in their order; the library itself last.
    const dirs = folders.map((f) => f.dir);
    const candidates = [...new Set([...dirs.filter((d) => d === library), ...dirs, library])];
    let best = { dir: candidates[0] as string, have: 0 };
    for (const dir of candidates) {
      let have = 0;
      for (const p of paths) if (await stat(path.join(dir, ...p.split('/'))).catch(() => undefined)) have++;
      if (have > best.have) best = { dir, have };
    }
    return best.dir;
  }

  /** What the destination holds of a file: its state, and the size / known sha256 of the copy there (the version an update replaces). */
  private async onDisk(
    dest: string,
    sidecar: DownloadSidecar | undefined,
    f: { path: string; sizeBytes?: number | undefined; sha256?: string | undefined },
  ): Promise<{ state: LocalFileState; sizeBytes?: number; sha256?: string }> {
    const abs = path.join(dest, ...f.path.split('/'));
    const st = await stat(abs).catch(() => undefined);
    if (!st) return { state: 'get' };
    const entry = sidecar?.files[f.path];
    const sha256 = entry?.sha256 && entry.sizeBytes === st.size ? entry.sha256 : await this.opts.knownSha?.(abs, st.size, st.mtimeMs);
    const disk = { sizeBytes: st.size, ...(sha256 ? { sha256 } : {}) };
    if (st.size !== f.sizeBytes) return { state: 'update', ...disk };
    // No hub sha256 (a small file kept in git): the size is all there is to compare.
    if (!f.sha256) return { state: 'have', ...disk };
    if (sha256 === undefined) return { state: 'check', ...disk };
    return { state: sha256 === f.sha256 ? 'have' : 'update', ...disk };
  }

  /** A file's state as the job now knows it; the job's total counts only what it fetches. */
  private setLocal(rec: JobRecord, f: DownloadJob['files'][number], local: LocalFileState): void {
    f.local = local;
    rec.job.bytesTotal = totalOf(rec.job);
  }

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
      await this.planSidecar(rec);
      for (const f of job.files) {
        if (rec.done.includes(f.path)) continue;
        const dest = path.join(job.dest, ...f.path.split('/'));
        // What is there now (the job may resume much later, another job may have fetched the file).
        const disk = await this.onDisk(job.dest, await readSidecar(job.dest), f);
        let local = disk.state;
        if (local === 'check') {
          // Same size, sha256 unknown: hashed before deciding, so a correct file is never fetched again.
          this.setState(rec, 'verifying');
          const sha = await (this.opts.hashFile ?? ((file, signal) => sha256File(file, { signal })))(dest, rec.abort.signal);
          this.setState(rec, 'running');
          local = sha === f.sha256 ? 'have' : 'update';
          if (local === 'have') await this.writeSidecar(rec, f.path, sha, disk.sizeBytes as number);
        } else if (local === 'have' && f.sha256 && disk.sha256 === f.sha256) {
          // Known (sidecar or hash cache): the sidecar keeps it, so the library knows it without hashing.
          await this.writeSidecar(rec, f.path, f.sha256, disk.sizeBytes as number);
        }
        this.setLocal(rec, f, local);
        if (local !== 'have') {
          // An update: the old file stays until the new one is verified, then the rename swaps them.
          const previous = local === 'update' ? { sizeBytes: disk.sizeBytes as number, ...(disk.sha256 ? { sha256: disk.sha256 } : {}) } : undefined;
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
          await this.writeSidecar(rec, f.path, result.sha256, result.bytes, previous);
        }
        rec.done.push(f.path);
        rec.doneBytes = this.doneBytesOf(rec);
        job.bytesDone = rec.doneBytes;
        await this.persist();
      }
      await this.verifySums(rec);
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
        await this.dropPlanned(rec);
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

  /**
   * A SHA256SUMS file in the job (NInfer artifacts ship one) is checked against what was downloaded: a
   * file that does not match is deleted and the job fails with DOWNLOAD_CHECKSUM, like a bad LFS hash.
   */
  private async verifySums(rec: JobRecord): Promise<void> {
    const sumsFile = rec.job.files.find((f) => NINFER_SUMS.test(f.path));
    if (!sumsFile) return;
    const at = (p: string) => path.join(rec.job.dest, ...p.split('/'));
    const sums = parseSha256Sums(await readFile(at(sumsFile.path), 'utf8'));
    const sidecar = await readSidecar(rec.job.dest);
    for (const f of rec.job.files) {
      const expected = sums.get(path.posix.basename(f.path)) ?? sums.get(f.path);
      const actual = sidecar?.files[f.path]?.sha256;
      if (!expected || !actual || expected === actual) continue;
      await rm(at(f.path), { force: true });
      rec.done = rec.done.filter((p) => p !== f.path);
      rec.doneBytes = this.doneBytesOf(rec);
      throw new AppError('DOWNLOAD_CHECKSUM', `Checksum mismatch for ${path.posix.basename(f.path)} (SHA256SUMS)`, {
        params: { file: path.posix.basename(f.path), expected, actual },
      });
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
    return rec.job.files.filter((f) => rec.done.includes(f.path)).reduce((a, f) => a + counted(f), 0);
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

  /** Reads the repo folder's sidecar (a fresh one when there is none), changes it and writes it back. */
  private async updateSidecar(rec: JobRecord, change: (s: DownloadSidecar) => DownloadSidecar): Promise<void> {
    const existing = (await readSidecar(rec.job.dest)) ?? { repo: rec.job.repo as string, revision: rec.revision, files: {} };
    await writeFileAtomic(path.join(rec.job.dest, DOWNLOAD_SIDECAR), JSON.stringify(change(existing), null, 2));
  }

  /** A verified file; `previous` is the version an update replaced (results measured with it keep pointing at it). */
  private writeSidecar(rec: JobRecord, file: string, sha256: string, bytes: number, previous?: { sha256?: string; sizeBytes: number }): Promise<void> {
    // The commit the hub resolved the files at (the revision asked for may be a branch name).
    return this.updateSidecar(rec, (s) => {
      // The same file written again (found already there) keeps the version it replaced.
      const keep = previous ?? (s.files[file]?.sha256 === sha256 ? s.files[file]?.previous : undefined);
      return { ...s, revision: rec.commit ?? s.revision, files: { ...s.files, [file]: { sha256, sizeBytes: bytes, ...(keep ? { previous: keep } : {}) } } };
    });
  }

  /**
   * Records what a job of several files sets out to fetch (`planned`, merged with earlier jobs into the
   * same folder) before its first byte. A single file needs no record: until it is complete it is a .part.
   */
  private async planSidecar(rec: JobRecord): Promise<void> {
    if (rec.job.files.length < 2) return;
    await this.updateSidecar(rec, (s) => ({ ...s, planned: [...new Set([...(s.planned ?? []), ...rec.job.files.map((f) => f.path)])].sort() }));
  }

  /** A cancelled job: what it never finished is no longer planned (the folder reads as what it really holds). */
  private async dropPlanned(rec: JobRecord): Promise<void> {
    if (!(await readSidecar(rec.job.dest))?.planned) return;
    const unfinished = new Set(rec.job.files.map((f) => f.path).filter((p) => !rec.done.includes(p)));
    await this.updateSidecar(rec, ({ planned, ...s }) => {
      const left = (planned as string[]).filter((p) => !unfinished.has(p));
      return left.length > 0 ? { ...s, planned: left } : s;
    });
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

/** Bytes a file adds to its job: none when the PC has it, or may have it ('check': only if it turns out different). */
function counted(f: DownloadJob['files'][number]): number {
  return f.local === 'have' || f.local === 'check' ? 0 : sizeOf(f);
}

function totalOf(job: DownloadJob): number {
  return job.files.reduce((a, f) => a + counted(f), 0);
}

function pick(e: { code: string; message: string }): { code: string; message: string } {
  return { code: e.code, message: e.message };
}
