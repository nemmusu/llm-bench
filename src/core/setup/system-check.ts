import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { SystemResponse } from '../../contract/api';
import type { EngineStatus } from '../../contract/engines';
import { AppError, toAppErrorData, type AppErrorData, type ErrorCode } from '../../contract/errors';
import type { GpuInfo } from '../../contract/hardware';
import type { Platform } from '../deps';
import type { TelemetryStatus } from '../telemetry/factory';
import { linuxDistroSupport } from './docker-linux';
import { driverCheck, type DriverCheckResult } from './driver';
import type { OsRelease } from './os-release';

export const CHECK_IDS = ['driver', 'gpu', 'llamacpp', 'models', 'disk', 'docker', 'vllm-native'] as const;
export type CheckId = (typeof CHECK_IDS)[number];

/** Traffic light: ok (green), missing (red, or grey when optional), warning (amber), optional (grey), unsupported. */
export type CheckState = 'ok' | 'missing' | 'warning' | 'optional' | 'unsupported';

export type CheckActionKind =
  | 'install-llamacpp'
  | 'open-driver-page'
  | 'install-docker'
  | 'start-docker'
  /** Docker Desktop is up but does not answer: "Riavvia Docker". */
  | 'restart-docker'
  | 'install-docker-linux'
  | 'install-uv'
  | 'install-vllm'
  | 'pick-model'
  | 'free-disk';

/** The ONE button that fixes the item. `bytes` is the download size shown in the confirmation. */
export interface CheckAction {
  kind: CheckActionKind;
  bytes?: number;
  url?: string;
}

export type CheckParams = Record<string, string | number | boolean | string[]>;

export interface CheckItem {
  id: CheckId;
  state: CheckState;
  /** Needed to benchmark at all (driver, GPU, an engine, a model); the others are extras. */
  required: boolean;
  params: CheckParams;
  /** Why the item is not ok, as a contract error code (localized by the renderer). */
  code?: ErrorCode;
  action?: CheckAction;
  /** The check itself failed or timed out (the item is then "warning"). */
  error?: AppErrorData;
}

export interface SystemCheckReport {
  platform: Platform;
  items: CheckItem[];
  /** Driver and GPU are fine: llama.cpp and models can be installed inline from the benchmark flow. */
  canBenchmark: boolean;
  checkedAt: string;
}

export type DockerStatusLike = { state: SystemResponse['docker']['state']; version?: string; reason?: string };

export interface StatFsLike {
  bavail: number | bigint;
  bsize: number | bigint;
}

/**
 * Every source is an injected async function, so the check runs against fakes in tests and
 * never imports the other modules' internals. Optional sources simply drop their item's detail.
 */
export interface SystemCheckSources {
  platform: Platform;
  arch: string;
  /** createTelemetry().status() */
  telemetryStatus: () => Promise<Pick<TelemetryStatus, 'found' | 'works' | 'driverVersion' | 'cudaVersion' | 'error'>>;
  /** createTelemetry().probe() */
  probeGpus: () => Promise<GpuInfo[]>;
  /** From the system fingerprint (WSL runs on the Windows driver). */
  isWsl?: () => Promise<boolean>;
  osRelease?: () => Promise<OsRelease | undefined>;
  /** Llama native adapter detect(). */
  llamacpp: () => Promise<EngineStatus>;
  /** Download size of the llama.cpp build installPlan() would pick. */
  llamacppInstallBytes?: () => Promise<number>;
  /** Local models (ModelsService.list()); only `dir` is read. */
  localModels: () => Promise<readonly { dir: string }[]>;
  /** Folder new downloads go to (settings.modelsDir or the default). */
  modelsDir: () => Promise<string>;
  statfs?: (p: string) => Promise<StatFsLike>;
  dockerStatus?: () => Promise<DockerStatusLike>;
  /** Docker Desktop installer size (HEAD). */
  dockerInstallBytes?: () => Promise<number | undefined>;
  /** vLLM native (Linux): is it usable already? */
  vllmNative?: () => Promise<{ installed: boolean; version?: string }>;
  uvPath?: () => Promise<string | undefined>;
  uvInstallBytes?: () => Promise<number | undefined>;
  /** Forget cached detections before a fresh check (telemetry.refresh, docker cache…). */
  refresh?: () => void;
  clockWall?: () => number;
  /** Per-source timeout (default 20 s). */
  timeoutMs?: number;
  /** Below this much free space in the models folder the disk item turns amber (default 20 GiB). */
  minFreeBytes?: number;
}

const GIB = 1024 ** 3;
export const DEFAULT_MIN_FREE_BYTES = 20 * GIB;

const round1 = (n: number) => Math.round(n * 10) / 10;

/** Free bytes of the volume holding `p`, walking up to the nearest existing folder (the models dir may not exist yet). */
export async function freeBytes(p: string, statfs: (p: string) => Promise<StatFsLike>): Promise<{ path: string; free: number }> {
  let cur = path.resolve(p);
  for (;;) {
    try {
      const s = await statfs(cur);
      return { path: cur, free: Number(s.bavail) * Number(s.bsize) };
    } catch (e) {
      const parent = path.dirname(cur);
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT' || parent === cur) throw e;
      cur = parent;
    }
  }
}

/** Builds the "Controllo sistema" checklist. Each source degrades on its own: one failure never hides the others. */
export class SystemCheck {
  constructor(private readonly s: SystemCheckSources) {}

  /** Runs `fn` with a timeout; a failure becomes AppErrorData instead of a rejection. */
  private async soft<T>(fn: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: AppErrorData }> {
    let timer: NodeJS.Timeout | undefined;
    const ms = this.s.timeoutMs ?? 20_000;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new AppError('INTERNAL', `Check timed out after ${ms} ms`, { params: { reason: 'timeout' } })), ms);
      });
      return { ok: true, value: await Promise.race([fn(), timeout]) };
    } catch (e) {
      return { ok: false, error: toAppErrorData(e) };
    } finally {
      clearTimeout(timer);
    }
  }

  private failedItem(id: CheckId, required: boolean, error: AppErrorData): CheckItem {
    return { id, state: 'warning', required, params: {}, code: error.code, error };
  }

  /** Driver verdict (also served alone by GET /api/setup/driver). */
  async driver(): Promise<DriverCheckResult> {
    const [status, gpus, isWsl, osRelease] = await Promise.all([
      this.s.telemetryStatus(),
      this.s.probeGpus().catch((): GpuInfo[] => []),
      (this.s.isWsl?.() ?? Promise.resolve(false)).catch(() => false),
      (this.s.osRelease?.() ?? Promise.resolve(undefined)).catch(() => undefined),
    ]);
    return driverCheck({
      gpus,
      platform: this.s.platform,
      isWsl,
      ...(status.driverVersion ? { driverVersion: status.driverVersion } : {}),
      ...(status.cudaVersion ? { cudaVersion: status.cudaVersion } : {}),
      ...(osRelease ? { osRelease } : {}),
    });
  }

  async check(opts: { fresh?: boolean } = {}): Promise<SystemCheckReport> {
    if (opts.fresh) this.s.refresh?.();
    const [driver, gpu, llamacpp, models, disk, docker, vllm] = await Promise.all([
      this.driverItem(),
      this.gpuItem(),
      this.llamacppItem(),
      this.modelsItem(),
      this.diskItem(),
      this.dockerItem(),
      this.vllmItem(),
    ]);
    const items = [driver, gpu, llamacpp, models, disk, docker, vllm];
    return {
      platform: this.s.platform,
      items,
      canBenchmark: driver.state === 'ok' && gpu.state === 'ok',
      checkedAt: new Date((this.s.clockWall ?? Date.now)()).toISOString(),
    };
  }

  private async driverItem(): Promise<CheckItem> {
    const r = await this.soft(() => this.driver());
    if (!r.ok) return this.failedItem('driver', true, r.error);
    const d = r.value;
    const params: CheckParams = {};
    if (d.driverVersion) params.driverVersion = d.driverVersion;
    if (d.cudaVersion) params.cudaVersion = d.cudaVersion;
    if (d.minRequired) params.minRequired = d.minRequired;
    if (d.architecture) params.architecture = d.architecture;
    if (d.linuxGuidance) params.guidance = d.linuxGuidance;
    if (d.state === 'ok') return { id: 'driver', state: 'ok', required: true, params };
    const url = d.links[0]?.url;
    return {
      id: 'driver',
      state: d.recommendedAction === 'none' ? 'unsupported' : 'missing',
      required: true,
      params,
      code: d.state === 'too-old' ? 'DRIVER_TOO_OLD' : 'DRIVER_MISSING',
      ...(url ? { action: { kind: 'open-driver-page', url } } : {}),
    };
  }

  private async gpuItem(): Promise<CheckItem> {
    if (this.s.platform !== 'win32' && this.s.platform !== 'linux') {
      return { id: 'gpu', state: 'unsupported', required: true, params: {}, code: 'GPU_NOT_FOUND' };
    }
    const r = await this.soft(async () => {
      const status = await this.s.telemetryStatus();
      const gpus = status.works ? await this.s.probeGpus() : [];
      return { status, gpus };
    });
    if (!r.ok) return this.failedItem('gpu', true, r.error);
    const { status, gpus } = r.value;
    const nvidia = gpus.filter((g) => g.vendor === 'nvidia');
    const first = nvidia[0];
    if (first) {
      const params: CheckParams = { name: first.name, vramGb: round1(first.memoryTotalMiB / 1024), count: nvidia.length };
      if (first.computeCapability) params.computeCapability = first.computeCapability;
      return { id: 'gpu', state: 'ok', required: true, params };
    }
    if (gpus.length > 0) return { id: 'gpu', state: 'unsupported', required: true, params: { name: (gpus[0] as GpuInfo).name }, code: 'GPU_NOT_FOUND' };
    // Without a working driver the GPU cannot be listed: the driver item carries the fix.
    const driverMissing = !status.found || status.error?.code === 'DRIVER_MISSING';
    return { id: 'gpu', state: 'missing', required: true, params: {}, code: driverMissing ? 'DRIVER_MISSING' : 'GPU_NOT_FOUND' };
  }

  private async llamacppItem(): Promise<CheckItem> {
    const r = await this.soft(() => this.s.llamacpp());
    if (!r.ok) return this.failedItem('llamacpp', true, r.error);
    const st = r.value;
    const params: CheckParams = {};
    if (st.version) params.version = st.version;
    if (st.variant) params.variant = st.variant;
    if (st.location) params.location = st.location;
    if (st.installed && st.available) return { id: 'llamacpp', state: 'ok', required: true, params };
    const bytes = await this.optionalBytes(this.s.llamacppInstallBytes);
    const action: CheckAction = { kind: 'install-llamacpp', ...(bytes !== undefined ? { bytes } : {}) };
    if (st.installed) {
      const code = (st.problems[0] as ErrorCode | undefined) ?? 'ENGINE_START_FAILED';
      // A missing system library is fixed with the package manager, not by reinstalling llama.cpp.
      if (code === 'ENGINE_MISSING_LIBRARY') return { id: 'llamacpp', state: 'warning', required: true, params: { ...params, ...st.problemParams }, code };
      return { id: 'llamacpp', state: 'warning', required: true, params, code, action };
    }
    return { id: 'llamacpp', state: 'missing', required: true, params, code: 'ENGINE_NOT_INSTALLED', action };
  }

  private async optionalBytes(fn: (() => Promise<number | undefined>) | undefined): Promise<number | undefined> {
    if (!fn) return undefined;
    const r = await this.soft(fn);
    return r.ok && typeof r.value === 'number' && r.value > 0 ? r.value : undefined;
  }

  private async modelsItem(): Promise<CheckItem> {
    const r = await this.soft(() => this.s.localModels());
    if (!r.ok) return this.failedItem('models', true, r.error);
    const dirs = [...new Set(r.value.map((m) => m.dir))].slice(0, 5);
    if (r.value.length > 0) return { id: 'models', state: 'ok', required: true, params: { count: r.value.length, dirs } };
    return { id: 'models', state: 'missing', required: true, params: { count: 0, dirs }, code: 'MODEL_NOT_FOUND', action: { kind: 'pick-model' } };
  }

  private async diskItem(): Promise<CheckItem> {
    const statfs = this.s.statfs ?? ((p: string) => fs.statfs(p));
    const r = await this.soft(async () => freeBytes(await this.s.modelsDir(), statfs));
    if (!r.ok) return this.failedItem('disk', false, r.error);
    const min = this.s.minFreeBytes ?? DEFAULT_MIN_FREE_BYTES;
    const params: CheckParams = { freeGb: round1(r.value.free / GIB), path: r.value.path, minFreeGb: round1(min / GIB) };
    if (r.value.free >= min) return { id: 'disk', state: 'ok', required: false, params };
    return { id: 'disk', state: 'warning', required: false, params, code: 'DISK_FULL', action: { kind: 'free-disk', bytes: min - r.value.free } };
  }

  private async dockerItem(): Promise<CheckItem> {
    const { platform } = this.s;
    if (platform !== 'win32' && platform !== 'linux') return { id: 'docker', state: 'unsupported', required: false, params: {}, code: 'DOCKER_UNSUPPORTED' };
    const dockerStatus = this.s.dockerStatus;
    if (!dockerStatus) return { id: 'docker', state: 'optional', required: false, params: { dockerState: 'unknown' } };
    const r = await this.soft(() => dockerStatus());
    if (!r.ok) return this.failedItem('docker', false, r.error);
    const st = r.value;
    const params: CheckParams = { dockerState: st.state };
    if (st.version) params.version = st.version;
    if (st.reason) params.reason = st.reason;
    const item = (state: CheckState, extra: Partial<CheckItem> = {}): CheckItem => ({ id: 'docker', state, required: false, params, ...extra });
    switch (st.state) {
      case 'running':
        return item('ok');
      case 'stopped':
        return item('optional', { code: 'DOCKER_NOT_RUNNING', action: { kind: 'start-docker' } });
      case 'starting':
        return item('optional');
      case 'not-responding':
        // Linux: a system service, restarted with its own command (the UI says which).
        return item('warning', { code: 'DOCKER_NOT_RESPONDING', ...(platform === 'win32' ? { action: { kind: 'restart-docker' } } : {}) });
      case 'not-installed':
        return item('optional', { code: 'DOCKER_NOT_INSTALLED', ...(await this.dockerInstallAction(params)) });
      case 'no-permission':
        return item('warning', { code: 'DOCKER_PERMISSION', ...(await this.linuxInstallAction(params)) });
      case 'no-gpu':
        return item('warning', { code: 'DOCKER_NO_GPU', ...(await this.linuxInstallAction(params)) });
      case 'unsupported':
        return item('unsupported', { code: 'DOCKER_UNSUPPORTED' });
      default:
        // 'unknown': the docker module could not tell (CLI hung, odd context): no one-click fix.
        return item('warning');
    }
  }

  private async dockerInstallAction(params: CheckParams): Promise<Pick<CheckItem, 'action'>> {
    if (this.s.platform === 'win32') {
      const bytes = await this.optionalBytes(this.s.dockerInstallBytes);
      return { action: { kind: 'install-docker', ...(bytes !== undefined ? { bytes } : {}) } };
    }
    return this.linuxInstallAction(params);
  }

  /** Linux: the guided script fixes "not installed", "no permission" and "no GPU runtime" alike, on Ubuntu/Debian. */
  private async linuxInstallAction(params: CheckParams): Promise<Pick<CheckItem, 'action'>> {
    if (this.s.platform !== 'linux') return {};
    const os = await (this.s.osRelease?.() ?? Promise.resolve(undefined)).catch(() => undefined);
    const support = linuxDistroSupport(os);
    if (support.supported) return { action: { kind: 'install-docker-linux' } };
    params.distroSupport = support.reason;
    params.docs = support.docs;
    return {};
  }

  private async vllmItem(): Promise<CheckItem> {
    if (this.s.platform !== 'linux') return { id: 'vllm-native', state: 'unsupported', required: false, params: {} };
    const r = await this.soft(async () => {
      const [vllm, uv] = await Promise.all([
        this.s.vllmNative?.() ?? Promise.resolve<{ installed: boolean; version?: string }>({ installed: false }),
        this.s.uvPath?.() ?? Promise.resolve(undefined),
      ]);
      return { vllm, uv };
    });
    if (!r.ok) return this.failedItem('vllm-native', false, r.error);
    const { vllm, uv } = r.value;
    if (vllm.installed) return { id: 'vllm-native', state: 'ok', required: false, params: vllm.version ? { version: vllm.version } : {} };
    if (uv) return { id: 'vllm-native', state: 'optional', required: false, params: { uv: true }, action: { kind: 'install-vllm' } };
    const bytes = await this.optionalBytes(this.s.uvInstallBytes);
    return { id: 'vllm-native', state: 'optional', required: false, params: { uv: false }, action: { kind: 'install-uv', ...(bytes !== undefined ? { bytes } : {}) } };
  }
}
