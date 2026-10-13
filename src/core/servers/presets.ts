import { randomUUID } from 'node:crypto';
import type { StartServerRequest } from '../../contract/api';
import { engineBaseOf } from '../../contract/engines';
import { AppError } from '../../contract/errors';
import { SERVER_PRESETS_MAX, serverPresetInputSchema, type ServerPreset } from '../../contract/servers';
import type { Settings } from '../../contract/settings';

/** What the presets need from settings.json. */
export interface PresetsStore {
  get(): Promise<Pick<Settings, 'serverPresets'>>;
  update(patch: Pick<Settings, 'serverPresets'>): Promise<unknown>;
}

export interface ServerPresetsDeps {
  store: PresetsStore;
  /** Wall-clock ms. */
  now: () => number;
  newId?: () => string;
}

const invalid = (reason: string, params: Record<string, string | number> = {}) =>
  new AppError('VALIDATION', `Invalid server preset (${reason})`, { params: { reason, ...params } });

/** Same name, ignoring case and blanks around it. */
const sameName = (a: string, b: string) => a.trim().toLocaleLowerCase() === b.trim().toLocaleLowerCase();

/**
 * "I tuoi preset" of the Server page: a model, an engine, its settings and extra arguments, a port,
 * network access and "Avvia all'apertura di GPU Bench", saved in settings.serverPresets.
 */
export class ServerPresets {
  constructor(private readonly deps: ServerPresetsDeps) {}

  async list(): Promise<ServerPreset[]> {
    return (await this.deps.store.get()).serverPresets;
  }

  async get(id: string): Promise<ServerPreset> {
    const p = (await this.list()).find((x) => x.id === id);
    if (!p) throw invalid('preset_not_found', { id });
    return p;
  }

  async create(input: unknown): Promise<ServerPreset> {
    const data = this.check(input);
    const list = await this.list();
    if (list.length >= SERVER_PRESETS_MAX) throw invalid('too_many_presets', { max: SERVER_PRESETS_MAX });
    this.unique(list, data.name);
    const at = new Date(this.deps.now()).toISOString();
    const preset: ServerPreset = { ...data, id: this.deps.newId?.() ?? randomUUID(), createdAt: at, updatedAt: at };
    await this.deps.store.update({ serverPresets: [...list, preset] });
    return preset;
  }

  /** Changes some fields; `port` and `source` set to null are removed. */
  async update(id: string, patch: Record<string, unknown>): Promise<ServerPreset> {
    const list = await this.list();
    const current = list.find((x) => x.id === id);
    if (!current) throw invalid('preset_not_found', { id });
    const { id: _id, createdAt, updatedAt: _u, ...base } = current;
    const merged: Record<string, unknown> = { ...base, ...patch };
    for (const k of ['port', 'source'] as const) if (merged[k] === null) delete merged[k];
    const data = this.check(merged);
    this.unique(
      list.filter((x) => x.id !== id),
      data.name,
    );
    const next: ServerPreset = { ...data, id, createdAt, updatedAt: new Date(this.deps.now()).toISOString() };
    await this.deps.store.update({ serverPresets: list.map((x) => (x.id === id ? next : x)) });
    return next;
  }

  async remove(id: string): Promise<void> {
    const list = await this.list();
    if (!list.some((x) => x.id === id)) throw invalid('preset_not_found', { id });
    await this.deps.store.update({ serverPresets: list.filter((x) => x.id !== id) });
  }

  /** The presets marked "Avvia all'apertura di GPU Bench", in the order they were saved. */
  async autoStart(): Promise<ServerPreset[]> {
    return (await this.list()).filter((p) => p.autoStart);
  }

  private check(input: unknown): Omit<ServerPreset, 'id' | 'createdAt' | 'updatedAt'> {
    const parsed = serverPresetInputSchema.safeParse(input);
    // A failed parse always has an issue: the first one names the field to fix.
    if (!parsed.success) throw invalid('preset_invalid', { field: parsed.error.issues[0]!.path.join('.') });
    const data = parsed.data;
    // An external endpoint is already running somewhere else: there is nothing to start.
    if (engineBaseOf(data.engine.kind) === 'external' && data.engine.kind !== 'command') throw invalid('external');
    if (!data.model.localId && !data.model.repo) throw invalid('model_required');
    // A command template is the user's own program: GPU Bench cannot add the API key to it.
    if (data.network === 'lan' && data.engine.kind === 'command') throw invalid('lan_unsupported');
    return data;
  }

  private unique(others: readonly ServerPreset[], name: string): void {
    if (others.some((x) => sameName(x.name, name))) throw invalid('preset_name_taken', { name: name.trim() });
  }
}

/** The request that starts a preset (its port and network access included). */
export function presetRequest(p: ServerPreset): StartServerRequest {
  return {
    engine: p.engine,
    model: p.model,
    params: p.params,
    ...(p.port !== undefined ? { port: p.port } : {}),
    network: p.network,
    presetId: p.id,
    ...(p.recipe !== undefined ? { recipe: p.recipe } : {}),
  };
}
