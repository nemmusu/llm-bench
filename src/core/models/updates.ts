import { stat } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { checkUpdatesRequestSchema } from '../../contract/api';
import { AppError } from '../../contract/errors';
import { hubFileSchema, type ChangedFile, type HubFile, type LocalModel, type MissingExtra, type ModelUpdate, type ModelUpdates } from '../../contract/models';
import type { Clock, Logger } from '../deps';
import type { RouteModule } from '../server/app';
import { parseBody } from '../server/http-error';
import { readJsonFile, writeFileAtomic } from '../store/atomic';
import type { HubClient } from './hub';
import { REPO_RE } from './paths';
import { readSidecar } from './scanner';

/** The background check runs at most once a day. */
export const UPDATE_CHECK_EVERY_MS = 24 * 3600_000;
/** How often the background loop wakes to see whether a check is due. */
export const UPDATE_WAKE_MS = 3600_000;
/** The first look after start-up (the app settles first). */
export const UPDATE_FIRST_DELAY_MS = 60_000;
/** Pause between two repos of a check: never a burst of hub requests. */
export const UPDATE_SPACING_MS = 1_000;
/** A check asked again this soon answers from the last one: repeated clicks never hammer the hub. */
export const UPDATE_COOLDOWN_MS = 30_000;

const stateSchema = z.object({
  version: z.literal(1),
  checkedAt: z.string().optional(),
  repos: z.record(z.string(), z.object({ checkedAt: z.string(), files: z.array(hubFileSchema) })),
});
type State = z.infer<typeof stateSchema>;

export interface ModelUpdatesOptions {
  hub: Pick<HubClient, 'files'>;
  /** The PC's models (the last scan). */
  list: () => Promise<LocalModel[]>;
  clock: Clock;
  log: Logger;
  /** Where the last listings are kept (<data>/model-updates.json). */
  file: string;
}

/** What a listing keeps: enough to compare sizes and hashes and to offer the extras. */
function slim(f: HubFile): HubFile {
  return { path: f.path, sizeBytes: f.sizeBytes, kind: f.kind, ...(f.sha256 ? { sha256: f.sha256 } : {}), ...(f.quant ? { quant: f.quant } : {}) };
}

/** The vision projector or MTP head a download would add: f16 first, then bf16, then q8, else the smallest. */
function preferred(files: HubFile[]): HubFile | undefined {
  const rank = (f: HubFile) => {
    const name = path.posix.basename(f.path).toLowerCase();
    if (/(^|[^b])f16/.test(name)) return 0;
    if (name.includes('bf16')) return 1;
    return name.includes('q8') ? 2 : 3;
  };
  return [...files].sort((a, b) => rank(a) - rank(b) || a.sizeBytes - b.sizeBytes)[0];
}

/**
 * A local model against its repo's listing: downloaded files whose hub copy changed (another size, or
 * another sha256 when both are known), and for a GGUF the vision projector / MTP head the repo has next to
 * it and the PC does not.
 */
async function compare(m: LocalModel, repoDir: string, files: HubFile[]): Promise<{ changed: ChangedFile[]; extras: MissingExtra[] }> {
  const byPath = new Map(files.map((f) => [f.path, f]));
  const sidecar = await readSidecar(repoDir);
  const rel = (p: string) => path.relative(repoDir, p).split(path.sep).join('/');
  const changed: ChangedFile[] = [];
  for (const p of m.paths) {
    const hub = byPath.get(rel(p));
    const st = hub ? await stat(p).catch(() => undefined) : undefined;
    if (!hub || !st) continue;
    const entry = sidecar?.files[hub.path];
    const sha = entry?.sha256 && entry.sizeBytes === st.size ? entry.sha256 : p === m.paths[0] ? m.identity.sha256 : undefined;
    if (st.size === hub.sizeBytes && (hub.sha256 === undefined || sha === undefined || sha === hub.sha256)) continue;
    const label = hub.kind === 'weights' && hub.quant ? hub.quant : path.posix.basename(hub.path);
    changed.push({ path: hub.path, label, oldBytes: st.size, newBytes: hub.sizeBytes });
  }
  const extras: MissingExtra[] = [];
  if (m.identity.format === 'gguf') {
    const dir = path.posix.dirname(rel(m.paths[0] as string));
    for (const kind of ['mmproj', 'mtp'] as const) {
      if (m.auxiliary.some((a) => a.kind === kind)) continue;
      const pick = preferred(files.filter((f) => f.kind === kind && path.posix.dirname(f.path) === dir));
      if (pick) extras.push({ kind, path: pick.path, sizeBytes: pick.sizeBytes });
    }
  }
  return { changed, extras };
}

/**
 * "Aggiornamento disponibile": the PC's downloaded hub models against their repos' current listings.
 * A check lists each repo once (on demand, after a download, and at most once a day in the background,
 * one repo per second, stopping at a rate limit); what it found is kept on disk, and the status compares
 * it with the files on the PC (sizes, and the sha256 the download sidecar recorded).
 */
export class ModelUpdatesService {
  private state: State | undefined;
  private running: Promise<void> | undefined;

  constructor(private readonly opts: ModelUpdatesOptions) {}

  private async load(): Promise<State> {
    if (!this.state) {
      const parsed = stateSchema.safeParse(await readJsonFile(this.opts.file).catch(() => undefined));
      this.state = parsed.success ? parsed.data : { version: 1, repos: {} };
    }
    return this.state;
  }

  /** The repos the PC's models come from (each with a repo folder: a download, or <owner>/<repo>). */
  private async repos(): Promise<string[]> {
    const models = await this.opts.list();
    return [...new Set(models.filter((m) => m.repoDir !== undefined).flatMap((m) => (m.identity.repo ? [m.identity.repo] : [])))].sort();
  }

  /**
   * Lists one repo (the model page, a finished download) or every repo of the PC's models. A fresh
   * check asks the hub again (not its cache), unless one just ran; `fresh: false` reuses the listing a
   * download just fetched. Concurrent checks share the running one.
   */
  check(repo?: string, opts: { fresh?: boolean } = {}): Promise<void> {
    this.running ??= this.run(repo, opts.fresh ?? true).finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  private async run(repo: string | undefined, fresh: boolean): Promise<void> {
    const state = await this.load();
    const wall = this.opts.clock.wall();
    const last = repo === undefined ? state.checkedAt : state.repos[repo]?.checkedAt;
    if (fresh && last !== undefined && wall - Date.parse(last) < UPDATE_COOLDOWN_MS) return;
    const repos = repo === undefined ? await this.repos() : [repo];
    for (const [i, r] of repos.entries()) {
      if (i > 0) await this.opts.clock.sleep(UPDATE_SPACING_MS);
      try {
        const files = await this.opts.hub.files(r, 'main', fresh);
        state.repos[r] = { checkedAt: new Date(this.opts.clock.wall()).toISOString(), files: files.map(slim) };
      } catch (e) {
        this.opts.log.warn('update check failed', { repo: r, error: (e as Error).message });
        // Hugging Face asked to slow down: the other repos wait for the next check.
        if (e instanceof AppError && e.code === 'HF_RATE_LIMITED') break;
      }
    }
    if (repo === undefined) state.checkedAt = new Date(this.opts.clock.wall()).toISOString();
    // Repos no model of the PC comes from any more are forgotten.
    const keep = new Set(await this.repos());
    state.repos = Object.fromEntries(Object.entries(state.repos).filter(([r]) => keep.has(r)));
    await writeFileAtomic(this.opts.file, JSON.stringify(state)).catch((e: unknown) => this.opts.log.warn('cannot save update checks', { error: (e as Error).message }));
  }

  /** The background check, when the last one is a day old (or there never was one). */
  async maybeCheck(): Promise<void> {
    const { checkedAt } = await this.load();
    if (checkedAt !== undefined && this.opts.clock.wall() - Date.parse(checkedAt) < UPDATE_CHECK_EVERY_MS) return;
    await this.check();
  }

  /** Wakes every hour until `signal` fires (core shutdown); checks once a day. */
  async runInBackground(signal: AbortSignal): Promise<void> {
    try {
      await this.opts.clock.sleep(UPDATE_FIRST_DELAY_MS, signal);
      for (;;) {
        await this.maybeCheck().catch((e: unknown) => this.opts.log.warn('background update check failed', { error: (e as Error).message }));
        await this.opts.clock.sleep(UPDATE_WAKE_MS, signal);
      }
    } catch {
      // The core is shutting down.
    }
  }

  /** What the last checks found for the PC's models: only the models with something to say. */
  async status(): Promise<ModelUpdates> {
    const state = await this.load();
    const models: ModelUpdate[] = [];
    for (const m of await this.opts.list()) {
      const repo = m.identity.repo;
      const snap = repo === undefined ? undefined : state.repos[repo];
      if (!snap || !m.repoDir || m.incomplete) continue;
      const found = await compare(m, m.repoDir, snap.files);
      if (found.changed.length > 0 || found.extras.length > 0) models.push({ modelId: m.id, repo: repo as string, ...found, checkedAt: snap.checkedAt });
    }
    return { ...(state.checkedAt ? { checkedAt: state.checkedAt } : {}), checking: this.running !== undefined, models };
  }
}

/**
 *   GET  /api/models/updates          -> ModelUpdates (what the last checks found)
 *   POST /api/models/updates/check    ({ repo? }) -> ModelUpdates after checking one repo or all of them
 */
export function createUpdatesRoutes(updates: ModelUpdatesService): RouteModule {
  return (app) => {
    app.get('/api/models/updates', async (c) => c.json(await updates.status()));
    app.post('/api/models/updates/check', async (c) => {
      const { repo } = await parseBody(c, checkUpdatesRequestSchema);
      if (repo !== undefined && !REPO_RE.test(repo)) throw new AppError('VALIDATION', 'Invalid repo id', { params: { repo } });
      await updates.check(repo);
      return c.json(await updates.status());
    });
  };
}
