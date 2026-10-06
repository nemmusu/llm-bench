import { z } from 'zod';

export const gpuInfoSchema = z.object({
  index: z.number().int(),
  uuid: z.string(),
  name: z.string(),
  vendor: z.enum(['nvidia', 'other']),
  memoryTotalMiB: z.number(),
  memoryUsedMiB: z.number().optional(),
  driverVersion: z.string().optional(),
  /** CUDA version supported by the driver (from the nvidia-smi header), e.g. "13.4". */
  cudaVersion: z.string().optional(),
  computeCapability: z.string().optional(),
  powerLimitW: z.number().optional(),
  pcieGenMax: z.number().optional(),
  pcieWidthMax: z.number().optional(),
});
export type GpuInfo = z.infer<typeof gpuInfoSchema>;

/** One telemetry sample (nvidia-smi -lms). Times are ms since the run's monotonic origin. */
export const gpuSampleSchema = z.object({
  t: z.number(),
  gpu: z.number().int(),
  utilPct: z.number().nullable(),
  memUsedMiB: z.number().nullable(),
  memTotalMiB: z.number().nullable(),
  powerW: z.number().nullable(),
  tempC: z.number().nullable(),
  smClockMHz: z.number().nullable(),
  memClockMHz: z.number().nullable(),
  pcieGen: z.number().nullable(),
  pcieWidth: z.number().nullable(),
  /** Active clock-event reasons (e.g. "sw_thermal_slowdown"), empty when none. */
  throttle: z.array(z.string()),
});
export type GpuSample = z.infer<typeof gpuSampleSchema>;

export const osInfoSchema = z.object({
  platform: z.enum(['win32', 'linux', 'darwin', 'other']),
  release: z.string(),
  arch: z.string(),
  /** Human name, e.g. "Windows 11 Pro 24H2" or "Ubuntu 24.04.1 LTS". */
  name: z.string(),
  isWsl: z.boolean(),
  powerPlan: z.string().optional(),
});
export type OsInfo = z.infer<typeof osInfoSchema>;

export const hardwareFingerprintSchema = z.object({
  /** Stable, anonymous id of this PC (sha256 of machine id + salt), to tell "this PC" from others. */
  hostId: z.string(),
  hostLabel: z.string(),
  gpus: z.array(gpuInfoSchema),
  cpu: z.object({ model: z.string(), cores: z.number(), threads: z.number() }),
  ramBytes: z.number(),
  os: osInfoSchema,
});
export type HardwareFingerprint = z.infer<typeof hardwareFingerprintSchema>;
