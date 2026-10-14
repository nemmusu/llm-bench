/**
 * The Python environments LLM Bench creates with uv for vLLM and SGLang on Linux (contract/native-envs.ts):
 * the folder, its size, and its removal. Only LLM Bench's own folder under the engines dir is ever
 * deleted; a Python environment of the user's own (vllmPath / sglangPath) is never touched.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { NATIVE_ENV_KINDS, type NativeEnvKind, type NativeEnvPlan } from '../../../contract/native-envs';
import { AppError } from '../../../contract/errors';
import type { ServerEvent } from '../../../contract/events';
import type { Settings } from '../../../contract/settings';
import { sglangVenvPaths } from '../sglang-native/adapter';
import { venvPaths } from '../vllm-native/install';

export interface NativeEnvsDeps {
  platform: NodeJS.Platform;
  enginesDir: string;
  settings: { get(): Promise<Pick<Settings, 'lastEngine'>> };
  /** A benchmark or a server is running. */
  busy(): boolean;
  /** An install or an update of this engine is running (trackInstalls). */
  installing?(kind: NativeEnvKind): boolean;
}

const LABELS: Record<NativeEnvKind, string> = { 'vllm-native': 'vLLM', 'sglang-native': 'SGLang' };

/** ':kind' of the routes: only the two environments LLM Bench creates. */
export function parseNativeEnvKind(param: string): NativeEnvKind {
  if ((NATIVE_ENV_KINDS as readonly string[]).includes(param)) return param as NativeEnvKind;
  throw new AppError('VALIDATION', `No Python environment for ${param}`, { params: { kind: param } });
}

/** Bytes and files under a folder; links are counted as links, never followed (bin/python points outside). */
export async function folderSize(dir: string): Promise<{ bytes: number; files: number }> {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  const parts = await Promise.all(
    entries.map(async (e) => {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) return folderSize(p);
      const st = await fs.lstat(p).catch(() => undefined);
      return st ? { bytes: st.size, files: 1 } : { bytes: 0, files: 0 };
    }),
  );
  return parts.reduce((a, b) => ({ bytes: a.bytes + b.bytes, files: a.files + b.files }), { bytes: 0, files: 0 });
}

/**
 * Which environments an install or an update is writing right now, from the 'engine.install' events
 * (kinds `vllm-native`, `update:vllm-native`…): from the first event to 'done' or 'error'.
 */
export function trackInstalls(subscribe: (l: (e: ServerEvent) => void) => unknown): (kind: NativeEnvKind) => boolean {
  const active = new Set<string>();
  subscribe((e) => {
    if (e.type !== 'engine.install') return;
    if (e.stage === 'done' || e.stage === 'error') active.delete(e.kind);
    else active.add(e.kind);
  });
  return (kind) => active.has(kind) || active.has(`update:${kind}`);
}

export class NativeEnvs {
  private readonly removing = new Set<NativeEnvKind>();

  constructor(private readonly d: NativeEnvsDeps) {}

  folderOf(kind: NativeEnvKind): string {
    return kind === 'vllm-native' ? venvPaths(this.d.enginesDir).venv : sglangVenvPaths(this.d.enginesDir).venv;
  }

  /** The user's own environment chosen in Settings for this engine (one inside LLM Bench's folder is LLM Bench's). */
  private async own(kind: NativeEnvKind, folder: string): Promise<string | undefined> {
    const last = (await this.d.settings.get()).lastEngine;
    if (last?.kind !== kind || last.customEngineId !== undefined) return undefined;
    const p = kind === 'vllm-native' ? last.vllmPath : last.sglangPath;
    if (!p) return undefined;
    const r = path.resolve(p);
    return r === folder || r.startsWith(folder + path.sep) ? undefined : p;
  }

  private isBusy(kind: NativeEnvKind): boolean {
    return this.d.busy() || this.d.installing?.(kind) === true || this.removing.has(kind);
  }

  async plan(kind: NativeEnvKind): Promise<NativeEnvPlan> {
    const folder = this.folderOf(kind);
    const supported = this.d.platform === 'linux';
    const st = supported ? await fs.lstat(folder).catch(() => undefined) : undefined;
    const size = st?.isDirectory() ? await folderSize(folder) : { bytes: 0, files: 0 };
    const own = await this.own(kind, folder);
    return {
      kind,
      supported,
      installed: st !== undefined,
      folder,
      sizeBytes: size.bytes,
      files: size.files,
      ...(own !== undefined ? { own } : {}),
      busy: this.isBusy(kind),
    };
  }

  /** Deletes LLM Bench's environment folder; refused while a benchmark, a server or an install of it runs. */
  async remove(kind: NativeEnvKind): Promise<void> {
    if (this.d.platform !== 'linux') throw new AppError('VALIDATION', `${LABELS[kind]} runs natively on Linux only`, { params: { reason: 'unsupported-os', kind } });
    if (this.isBusy(kind)) throw new AppError('ENGINE_IN_USE', `${LABELS[kind]} is in use`, { params: { engine: LABELS[kind], reason: 'busy' } });
    const folder = this.folderOf(kind);
    if (!(await fs.lstat(folder).catch(() => undefined))) throw new AppError('ENGINE_NOT_INSTALLED', `${LABELS[kind]} is not installed: ${folder}`, { params: { kind, path: folder } });
    this.removing.add(kind);
    try {
      // A link in place of the folder goes alone: what it points to is never followed.
      await fs.rm(folder, { recursive: true, force: true });
    } finally {
      this.removing.delete(kind);
    }
  }
}
