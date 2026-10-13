import { createHash } from 'node:crypto';
import { readFile as fsReadFile } from 'node:fs/promises';
import nodeOs from 'node:os';
import type { GpuInfo, HardwareFingerprint, OsInfo } from '../../contract/hardware';
import type { CoreDeps, ProcessRunner } from '../deps';
import type { TelemetrySampler } from '../telemetry/types';

/** The bits of node:os we use, injectable so Windows/Linux branches run on any OS in tests. */
export interface OsApi {
  hostname(): string;
  cpus(): { model: string }[];
  totalmem(): number;
  release(): string;
}

export type ReadFile = (path: string) => Promise<string>;

export interface SysInfoOptions {
  /** GPUs for the fingerprint (normally the shared telemetry instance). */
  telemetry?: Pick<TelemetrySampler, 'probe'>;
  readFile?: ReadFile;
  os?: OsApi;
}

export interface SysInfo {
  /** Cached after the first call; GPUs are re-probed until at least one is found (driver installed later). */
  getFingerprint(): Promise<HardwareFingerprint>;
  /** Drops every cached value. */
  invalidate(): void;
}

export type SysInfoDeps = Pick<CoreDeps, 'proc' | 'platform' | 'arch'> & { log?: CoreDeps['log'] };

const CMD_TIMEOUT_MS = 10_000;
/** PowerShell cold start alone can take seconds on a busy machine. */
const PS_TIMEOUT_MS = 30_000;

/**
 * One PowerShell run for both values (each start costs ~0.5–1.5 s). Physical cores are summed over
 * sockets. Caption comes from CIM because the registry ProductName still says "Windows 10" on 11.
 * No double quotes inside: they would need escaping through CreateProcess → PowerShell.
 */
export const PS_SYSINFO_SCRIPT = [
  '[Console]::OutputEncoding=[Text.Encoding]::UTF8',
  '$c=(Get-CimInstance Win32_Processor | Measure-Object -Property NumberOfCores -Sum).Sum',
  '$o=(Get-CimInstance Win32_OperatingSystem).Caption',
  "Write-Output ('cores=' + $c)",
  "Write-Output ('caption=' + $o)",
].join('; ');

/** `reg query <key> /v <name>` → value of a REG_SZ line. */
export function parseRegValue(stdout: string, name: string): string | undefined {
  for (const line of stdout.split(/\r?\n/)) {
    const m = /^\s*(\S+)\s+REG_\w+\s+(.*?)\s*$/.exec(line);
    if (m?.[1]?.toLowerCase() === name.toLowerCase() && m[2]) return m[2];
  }
  return undefined;
}

/** `powercfg /getactivescheme` is localized ("GUID combinazione risparmio energia: … (Prestazioni elevate)"): take the outer parentheses. */
export function parsePowercfg(stdout: string): string | undefined {
  const m = /\((.+)\)\s*$/.exec(stdout.trim());
  return m?.[1]?.trim() || undefined;
}

/** Output of {@link PS_SYSINFO_SCRIPT}: "cores=20" / "caption=Microsoft Windows 11 Pro". */
export function parsePsSysinfo(stdout: string): { cores?: number; caption?: string } {
  const out: { cores?: number; caption?: string } = {};
  for (const line of stdout.split(/\r?\n/)) {
    const m = /^(cores|caption)=(.*)$/.exec(line.trim());
    const value = m?.[2]?.trim();
    if (!value) continue;
    if (m?.[1] === 'cores') {
      const n = Number(value);
      if (Number.isInteger(n) && n > 0) out.cores = n;
    } else {
      out.caption = value;
    }
  }
  return out;
}

/** "Microsoft Windows 11 Pro" + "26H2" → "Windows 11 Pro 26H2". */
export function windowsName(caption: string | undefined, displayVersion: string | undefined, release: string): string {
  const base = caption?.replace(/^Microsoft\s+/i, '').trim() || `Windows ${release}`;
  return displayVersion ? `${base} ${displayVersion}` : base;
}

/** /etc/os-release → PRETTY_NAME, else NAME + VERSION. */
export function parseOsRelease(text: string): string | undefined {
  const vars: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (m?.[1] && m[2] !== undefined) vars[m[1]] = m[2].replace(/^(["'])(.*)\1$/, '$2');
  }
  if (vars.PRETTY_NAME) return vars.PRETTY_NAME;
  if (vars.NAME) return vars.VERSION ? `${vars.NAME} ${vars.VERSION}` : vars.NAME;
  return undefined;
}

/** Physical cores = unique (physical id, core id) pairs; undefined when the kernel does not report them (ARM, some VMs). */
export function countPhysicalCores(cpuinfo: string): number | undefined {
  const cores = new Set<string>();
  for (const block of cpuinfo.split(/\r?\n\s*\r?\n/)) {
    const phys = /^physical id\s*:\s*(\d+)/m.exec(block)?.[1];
    const core = /^core id\s*:\s*(\d+)/m.exec(block)?.[1];
    if (core !== undefined) cores.add(`${phys ?? '0'}:${core}`);
  }
  return cores.size > 0 ? cores.size : undefined;
}

/**
 * Anonymous stable id: the raw machine id never leaves the PC (it ends up in shared result files).
 * The salt keeps the app's old name (GPU Bench): a new one would make this PC's earlier runs look
 * like another PC's.
 */
export function hostIdFrom(machineId: string): string {
  return createHash('sha256').update(`gpu-bench:${machineId.trim().toLowerCase()}`).digest('hex');
}

/** The fingerprint identifies hardware; live values (VRAM in use) would make it differ run to run. */
function staticGpu(g: GpuInfo): GpuInfo {
  const { memoryUsedMiB: _used, ...rest } = g;
  return rest;
}

async function runText(proc: ProcessRunner, cmd: string, args: string[], timeoutMs = CMD_TIMEOUT_MS): Promise<string | undefined> {
  const out = await proc.run(cmd, args, { timeoutMs });
  return out.code === 0 && !out.timedOut ? out.stdout : undefined;
}

interface HostPart {
  hostId: string;
  hostLabel: string;
  cpu: HardwareFingerprint['cpu'];
  ramBytes: number;
  os: OsInfo;
}

export function createSysInfo(deps: SysInfoDeps, opts: SysInfoOptions = {}): SysInfo {
  const os: OsApi = opts.os ?? nodeOs;
  const readFile: ReadFile = opts.readFile ?? ((p) => fsReadFile(p, 'utf8'));
  const tryRead = async (...paths: string[]): Promise<string | undefined> => {
    for (const p of paths) {
      try {
        return await readFile(p);
      } catch {
        /* next candidate */
      }
    }
    return undefined;
  };

  async function windowsPart(): Promise<{ machineId?: string; cores?: number; name: string; powerPlan?: string }> {
    const [guid, ps, display, power] = await Promise.all([
      runText(deps.proc, 'reg', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid']),
      runText(deps.proc, 'powershell', ['-NoProfile', '-NonInteractive', '-Command', PS_SYSINFO_SCRIPT], PS_TIMEOUT_MS),
      runText(deps.proc, 'reg', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion', '/v', 'DisplayVersion']),
      runText(deps.proc, 'powercfg', ['/getactivescheme']),
    ]);
    const psInfo = parsePsSysinfo(ps ?? '');
    const out: { machineId?: string; cores?: number; name: string; powerPlan?: string } = {
      name: windowsName(psInfo.caption, display ? parseRegValue(display, 'DisplayVersion') : undefined, os.release()),
    };
    const machineId = guid ? parseRegValue(guid, 'MachineGuid') : undefined;
    const powerPlan = power ? parsePowercfg(power) : undefined;
    if (machineId) out.machineId = machineId;
    if (psInfo.cores) out.cores = psInfo.cores;
    if (powerPlan) out.powerPlan = powerPlan;
    return out;
  }

  async function linuxPart(): Promise<{ machineId?: string; cores?: number; name: string; isWsl: boolean }> {
    const [machineId, osRelease, version, cpuinfo] = await Promise.all([
      tryRead('/etc/machine-id', '/var/lib/dbus/machine-id'),
      tryRead('/etc/os-release', '/usr/lib/os-release'),
      tryRead('/proc/version'),
      tryRead('/proc/cpuinfo'),
    ]);
    const out: { machineId?: string; cores?: number; name: string; isWsl: boolean } = {
      name: (osRelease && parseOsRelease(osRelease)) || `Linux ${os.release()}`,
      isWsl: /microsoft/i.test(version ?? ''),
    };
    const cores = cpuinfo ? countPhysicalCores(cpuinfo) : undefined;
    if (machineId?.trim()) out.machineId = machineId.trim();
    if (cores) out.cores = cores;
    return out;
  }

  async function hostPart(): Promise<HostPart> {
    const cpus = os.cpus();
    const threads = Math.max(1, cpus.length);
    const hostLabel = os.hostname();
    let specific: { machineId?: string; cores?: number; name: string; isWsl?: boolean; powerPlan?: string };
    if (deps.platform === 'win32') specific = await windowsPart();
    else if (deps.platform === 'linux') specific = await linuxPart();
    else specific = { name: `macOS ${os.release()}` };
    const osInfo: OsInfo = {
      platform: deps.platform,
      release: os.release(),
      arch: deps.arch,
      name: specific.name,
      isWsl: specific.isWsl ?? false,
    };
    if (specific.powerPlan) osInfo.powerPlan = specific.powerPlan;
    return {
      hostId: hostIdFrom(specific.machineId ?? hostLabel),
      hostLabel,
      cpu: {
        model: cpus[0]?.model.replace(/\s+/g, ' ').trim() || 'unknown',
        cores: specific.cores ?? threads,
        threads,
      },
      ramBytes: os.totalmem(),
      os: osInfo,
    };
  }

  let host: Promise<HostPart> | undefined;
  let gpus: GpuInfo[] | undefined;

  async function probeGpus(): Promise<GpuInfo[]> {
    if (gpus) return gpus;
    let found: GpuInfo[] = [];
    try {
      found = (await opts.telemetry?.probe())?.map(staticGpu) ?? [];
    } catch (e) {
      deps.log?.warn('GPU probe failed for the fingerprint', { error: String(e) });
    }
    if (found.length > 0) gpus = found;
    return found;
  }

  return {
    async getFingerprint() {
      host ??= hostPart().catch((e: unknown) => {
        host = undefined;
        throw e;
      });
      const [h, g] = await Promise.all([host, probeGpus()]);
      return { ...h, gpus: g };
    },
    invalidate() {
      host = undefined;
      gpus = undefined;
    },
  };
}
