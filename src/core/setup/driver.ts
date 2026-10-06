import { z } from 'zod';
import type { GpuInfo } from '../../contract/hardware';
import type { Platform } from '../deps';
import { isUbuntuLike, type OsRelease } from './os-release';
import requirementsJson from '../../../resources/driver-requirements.json';

const version = z.string().regex(/^\d+(\.\d+)*$/);

export const driverRequirementsSchema = z.object({
  schema: z.literal(1),
  cudaDrivers: z.array(z.object({ cuda: version, linux: version, win32: version })).min(1),
  minorVersionCompatibility: z.array(z.object({ cudaMajor: z.number().int(), linux: version, win32: version })),
  appMinimumCuda: z.object({ win32: version, linux: version }),
  architectures: z.array(
    z.object({
      id: z.string(),
      computeCapability: z.array(z.string()),
      namePattern: z.string(),
      minCuda: version,
      linux: version,
      win32: version,
    }),
  ),
  links: z.object({
    driverPage: z.string().url(),
    nvidiaApp: z.string().url(),
    ubuntu: z.string().url(),
    debian: z.string().url(),
    fedora: z.string().url(),
    nvidiaLinux: z.string().url(),
  }),
});
export type DriverRequirements = z.infer<typeof driverRequirementsSchema>;

/** Bundled table (resources/driver-requirements.json, sources cited there); validated once at load. */
export const DRIVER_REQUIREMENTS: DriverRequirements = driverRequirementsSchema.parse(requirementsJson);

/** Official NVIDIA pages a beginner is sent to (never a third-party mirror). */
export const NVIDIA_DRIVER_PAGE = DRIVER_REQUIREMENTS.links.driverPage;
export const NVIDIA_APP_PAGE = DRIVER_REQUIREMENTS.links.nvidiaApp;

/** Which driver numbering a check uses: WSL runs on the Windows driver, so it uses the Windows column. */
export type DriverOs = 'win32' | 'linux';

/** "617.14" / "570.86.16" → [617, 14] / [570, 86, 16]; undefined for anything else ("N/A", "R570"). */
export function parseDriverVersion(v: string | undefined): number[] | undefined {
  const m = /^\s*(\d+(?:\.\d+)*)\s*$/.exec(v ?? '');
  return m ? (m[1] as string).split('.').map(Number) : undefined;
}

/** Segment-wise comparison; missing segments count as 0 ("615" == "615.00"). */
export function compareVersions(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

function atLeast(driver: readonly number[], min: string): boolean {
  return compareVersions(driver, parseDriverVersion(min) as number[]) >= 0;
}

function driverOs(platform: Platform, isWsl: boolean | undefined): DriverOs | undefined {
  if (platform === 'win32' || isWsl) return 'win32';
  return platform === 'linux' ? 'linux' : undefined;
}

/**
 * Highest CUDA version the driver supports according to the bundled table. Fallback for when
 * nvidia-smi does not print "CUDA Version" (old drivers, some WSL setups).
 */
export function maxCudaForDriver(
  driver: string,
  platform: Platform,
  opts: { isWsl?: boolean; table?: DriverRequirements } = {},
): string | undefined {
  const parsed = parseDriverVersion(driver);
  const os = driverOs(platform, opts.isWsl);
  if (!parsed || !os) return undefined;
  const rows = [...(opts.table ?? DRIVER_REQUIREMENTS).cudaDrivers].sort((a, b) =>
    compareVersions(parseDriverVersion(b.cuda) as number[], parseDriverVersion(a.cuda) as number[]),
  );
  return rows.find((r) => atLeast(parsed, r[os]))?.cuda;
}

/** Minimum driver for a CUDA version (exact table row, else the row of the next CUDA version up). */
export function minDriverForCuda(cuda: string, os: DriverOs, table: DriverRequirements = DRIVER_REQUIREMENTS): string | undefined {
  const want = parseDriverVersion(cuda);
  if (!want) return undefined;
  const rows = [...table.cudaDrivers]
    .filter((r) => compareVersions(parseDriverVersion(r.cuda) as number[], want) >= 0)
    .sort((a, b) => compareVersions(parseDriverVersion(a.cuda) as number[], parseDriverVersion(b.cuda) as number[]));
  return rows[0]?.[os];
}

/** The architecture rule a GPU falls under: by compute capability, else by name. */
export function architectureOf(gpu: Pick<GpuInfo, 'name' | 'computeCapability'>, table: DriverRequirements = DRIVER_REQUIREMENTS) {
  return table.architectures.find((a) =>
    gpu.computeCapability !== undefined ? a.computeCapability.includes(gpu.computeCapability) : new RegExp(a.namePattern, 'i').test(gpu.name),
  );
}

/** How a Linux user is told to install the driver (the code picks the localized guide in the UI). */
export type LinuxDriverGuidance = 'ubuntu-drivers' | 'debian-nonfree' | 'rpmfusion' | 'nvidia-docs';

export function linuxDriverGuidance(os: OsRelease | undefined, table: DriverRequirements = DRIVER_REQUIREMENTS): { code: LinuxDriverGuidance; url: string } {
  if (os && isUbuntuLike(os)) return { code: 'ubuntu-drivers', url: table.links.ubuntu };
  if (os?.id === 'debian' || os?.idLike.includes('debian')) return { code: 'debian-nonfree', url: table.links.debian };
  if (os?.id === 'fedora' || os?.idLike.includes('fedora')) return { code: 'rpmfusion', url: table.links.fedora };
  return { code: 'nvidia-docs', url: table.links.nvidiaLinux };
}

export type DriverState = 'ok' | 'too-old' | 'missing';
export type DriverAction = 'none' | 'open-driver-page' | 'linux-driver-guide';

export interface DriverLink {
  kind: 'driver-page' | 'nvidia-app' | 'linux-guide';
  url: string;
}

export interface DriverCheckInput {
  gpus: readonly Pick<GpuInfo, 'name' | 'vendor' | 'computeCapability'>[];
  driverVersion?: string;
  /** "CUDA Version" printed by nvidia-smi; derived from the table when absent. */
  cudaVersion?: string;
  platform: Platform;
  /** WSL uses the Windows driver: Windows numbering and the Windows download page. */
  isWsl?: boolean;
  osRelease?: OsRelease;
}

export interface DriverCheckResult {
  state: DriverState;
  driverVersion?: string;
  cudaVersion?: string;
  cudaSource?: 'nvidia-smi' | 'table';
  /** Lowest driver that satisfies GPU Bench and every detected GPU. */
  minRequired?: string;
  /** What sets minRequired: the oldest installable llama.cpp CUDA build, or the GPU architecture. */
  reason?: 'app-minimum' | 'architecture';
  architecture?: string;
  recommendedAction: DriverAction;
  /** Linux only: which distro guide applies. */
  linuxGuidance?: LinuxDriverGuidance;
  links: DriverLink[];
}

/**
 * Decides whether the installed NVIDIA driver is good enough. Thresholds: the driver of the
 * oldest CUDA build of llama.cpp we can install on this OS, raised by the GPU's architecture
 * rule (e.g. RTX 50 needs R570). Never throws: unknown inputs mean "missing".
 */
export function driverCheck(input: DriverCheckInput, table: DriverRequirements = DRIVER_REQUIREMENTS): DriverCheckResult {
  const os = driverOs(input.platform, input.isWsl);
  const guide = input.platform === 'linux' && !input.isWsl ? linuxDriverGuidance(input.osRelease, table) : undefined;
  const links: DriverLink[] = guide
    ? [{ kind: 'linux-guide', url: guide.url }]
    : [
        { kind: 'driver-page', url: table.links.driverPage },
        { kind: 'nvidia-app', url: table.links.nvidiaApp },
      ];
  const fix: Pick<DriverCheckResult, 'recommendedAction' | 'linuxGuidance' | 'links'> = guide
    ? { recommendedAction: 'linux-driver-guide', linuxGuidance: guide.code, links }
    : { recommendedAction: 'open-driver-page', links };
  // macOS and others: there is no supported NVIDIA driver to point at.
  if (!os) return { state: 'missing', recommendedAction: 'none', links: [] };

  // The build GPU Bench installs follows the OS the core runs on (WSL runs Linux builds) …
  const appCuda = table.appMinimumCuda[input.platform === 'win32' ? 'win32' : 'linux'];
  // … but the driver numbering follows the driver's OS.
  let minRequired = minDriverForCuda(appCuda, os, table) as string;
  let reason: DriverCheckResult['reason'] = 'app-minimum';
  let architecture: string | undefined;
  for (const gpu of input.gpus) {
    if (gpu.vendor !== 'nvidia') continue;
    const arch = architectureOf(gpu, table);
    if (!arch) continue;
    architecture ??= arch.id;
    if (compareVersions(parseDriverVersion(arch[os]) as number[], parseDriverVersion(minRequired) as number[]) > 0) {
      minRequired = arch[os];
      reason = 'architecture';
      architecture = arch.id;
    }
  }
  const base = { minRequired, reason, ...(architecture ? { architecture } : {}) };

  const driver = parseDriverVersion(input.driverVersion);
  if (!driver) return { state: 'missing', ...base, ...fix };
  const reported = parseDriverVersion(input.cudaVersion) ? input.cudaVersion : undefined;
  const derived = reported ?? maxCudaForDriver(input.driverVersion as string, input.platform, { isWsl: input.isWsl ?? false, table });
  const cuda = {
    driverVersion: input.driverVersion as string,
    ...(derived ? { cudaVersion: derived, cudaSource: reported ? ('nvidia-smi' as const) : ('table' as const) } : {}),
  };
  if (!atLeast(driver, minRequired)) return { state: 'too-old', ...cuda, ...base, ...fix };
  return { state: 'ok', ...cuda, ...base, recommendedAction: 'none', ...(guide ? { linuxGuidance: guide.code } : {}), links };
}
