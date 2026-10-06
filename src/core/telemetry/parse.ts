import type { GpuInfo, GpuSample } from '../../contract/hardware';
import { decodeClockEventReasons } from './clock-reasons';
import { byKey, lines, num, splitRow, text, type ActiveField, type FieldSpec } from './fields';
import type { DriverInfo } from './nvidia-smi';

/** Static info per GPU. Old drivers lack compute_cap; driver_version is deprecated (617+) in favour of kmd_version. */
export const PROBE_FIELDS: readonly FieldSpec[] = [
  { key: 'index', names: ['index'], required: true },
  { key: 'uuid', names: ['uuid'], minimal: true },
  { key: 'name', names: ['name'], minimal: true },
  { key: 'memTotal', names: ['memory.total'], minimal: true },
  { key: 'memUsed', names: ['memory.used'], minimal: true },
  { key: 'driver', names: ['driver_version', 'kmd_version'] },
  { key: 'computeCap', names: ['compute_cap'] },
  { key: 'powerLimit', names: ['power.limit'] },
  { key: 'pcieGenMax', names: ['pcie.link.gen.max'] },
  { key: 'pcieWidthMax', names: ['pcie.link.width.max'] },
];

/**
 * Live sample. Both power columns are queried: power.draw.instant is preferred (power.draw is a
 * 1 s average on Ampere+, which smears the decode window), power.draw covers drivers/GPUs where
 * instant is unknown or "[N/A]". clocks_event_reasons was called clocks_throttle_reasons before R535.
 */
export const SAMPLE_FIELDS: readonly FieldSpec[] = [
  { key: 'index', names: ['index'], required: true },
  { key: 'util', names: ['utilization.gpu'], minimal: true },
  { key: 'memUsed', names: ['memory.used'], minimal: true },
  { key: 'memTotal', names: ['memory.total'], minimal: true },
  { key: 'powerInstant', names: ['power.draw.instant'] },
  { key: 'power', names: ['power.draw'], minimal: true },
  { key: 'temp', names: ['temperature.gpu'], minimal: true },
  { key: 'sm', names: ['clocks.sm'] },
  { key: 'mem', names: ['clocks.mem'] },
  { key: 'pcieGen', names: ['pcie.link.gen.current'] },
  { key: 'pcieWidth', names: ['pcie.link.width.current'] },
  { key: 'throttle', names: ['clocks_event_reasons.active', 'clocks_throttle_reasons.active'] },
];

function gpuIndex(cell: string | undefined): number | undefined {
  const n = num(cell);
  return n !== null && Number.isInteger(n) && n >= 0 ? n : undefined;
}

/** Probe CSV → GpuInfo[] (optional fields omitted when the driver reports a placeholder). */
export function parseProbe(stdout: string, fields: readonly ActiveField[], driver: DriverInfo = {}): GpuInfo[] {
  const nameCol = fields.findIndex((f) => f.key === 'name');
  const out: GpuInfo[] = [];
  for (const line of lines(stdout)) {
    const cells = splitRow(line, fields.length, nameCol >= 0 ? nameCol : undefined);
    if (!cells) continue;
    const v = byKey(fields, cells);
    const index = gpuIndex(v.index);
    if (index === undefined) continue;
    const info: GpuInfo = {
      index,
      uuid: text(v.uuid) ?? '',
      name: text(v.name) ?? '',
      vendor: 'nvidia',
      memoryTotalMiB: num(v.memTotal) ?? 0,
    };
    const memUsed = num(v.memUsed);
    const driverVersion = text(v.driver) ?? driver.driverVersion;
    const cc = text(v.computeCap);
    const powerLimit = num(v.powerLimit);
    const genMax = num(v.pcieGenMax);
    const widthMax = num(v.pcieWidthMax);
    if (memUsed !== null) info.memoryUsedMiB = memUsed;
    if (driverVersion) info.driverVersion = driverVersion;
    if (driver.cudaVersion) info.cudaVersion = driver.cudaVersion;
    if (cc) info.computeCapability = cc;
    if (powerLimit !== null) info.powerLimitW = powerLimit;
    if (genMax !== null) info.pcieGenMax = genMax;
    if (widthMax !== null) info.pcieWidthMax = widthMax;
    out.push(info);
  }
  return out.sort((a, b) => a.index - b.index);
}

/**
 * One sample row → GpuSample, or undefined for garbage/partial lines (wrong column count, no
 * integer GPU index), which a streaming nvidia-smi emits when it is killed mid-write.
 */
export function parseSampleRow(line: string, fields: readonly ActiveField[], t: number): GpuSample | undefined {
  const cells = splitRow(line, fields.length);
  if (!cells) return undefined;
  const v = byKey(fields, cells);
  const gpu = gpuIndex(v.index);
  if (gpu === undefined) return undefined;
  return {
    t,
    gpu,
    utilPct: num(v.util),
    memUsedMiB: num(v.memUsed),
    memTotalMiB: num(v.memTotal),
    powerW: num(v.powerInstant) ?? num(v.power),
    tempC: num(v.temp),
    smClockMHz: num(v.sm),
    memClockMHz: num(v.mem),
    pcieGen: num(v.pcieGen),
    pcieWidth: num(v.pcieWidth),
    throttle: decodeClockEventReasons(v.throttle),
  };
}

/** A one-shot sample query; every row gets the same arrival time. */
export function parseSamples(stdout: string, fields: readonly ActiveField[], t: number): GpuSample[] {
  const out: GpuSample[] = [];
  for (const line of lines(stdout)) {
    const s = parseSampleRow(line, fields, t);
    if (s) out.push(s);
  }
  return out.sort((a, b) => a.gpu - b.gpu);
}

export interface ComputeApp {
  pid: number;
  /** Full executable path as reported (WDDM may list desktop apps such as explorer.exe). */
  processName: string;
  /** null on Windows/WDDM ("[N/A]") and in some containers. */
  usedMiB: number | null;
}

/**
 * `--query-compute-apps=pid,process_name,used_memory`. Paths may contain commas, so the pid is
 * taken before the first comma and the memory after the last one.
 */
export function parseComputeApps(stdout: string): ComputeApp[] {
  const out: ComputeApp[] = [];
  for (const line of lines(stdout)) {
    const first = line.indexOf(',');
    const last = line.lastIndexOf(',');
    if (first < 0) continue;
    const pid = gpuIndex(line.slice(0, first));
    if (pid === undefined || pid === 0) continue;
    const twoCols = first === last;
    const processName = (twoCols ? line.slice(first + 1) : line.slice(first + 1, last)).trim();
    out.push({ pid, processName, usedMiB: twoCols ? null : num(line.slice(last + 1)) });
  }
  return out;
}
