/**
 * Decoder for `clocks_event_reasons.active` (alias `clocks_throttle_reasons.active`), a hex bitmask
 * such as "0x0000000000000400". Bit values are NVML's `nvmlClocksEventReason*` constants
 * (nvml.h). board_limit/reliability are newer bits: on driver 617.14 the supported mask is 0x7FF
 * and an idle RTX 5090 reports 0x400 with only "Reliability: Active" (see
 * test/fixtures/nvidia-smi/win-clock-reasons.csv), so 0x400 = reliability and 0x200 = board_limit.
 */
export const CLOCK_EVENT_REASONS: readonly (readonly [bit: bigint, name: string])[] = [
  [0x1n, 'gpu_idle'],
  [0x2n, 'applications_clocks_setting'],
  [0x4n, 'sw_power_cap'],
  [0x8n, 'hw_slowdown'],
  [0x10n, 'sync_boost'],
  [0x20n, 'sw_thermal_slowdown'],
  [0x40n, 'hw_thermal_slowdown'],
  [0x80n, 'hw_power_brake_slowdown'],
  [0x100n, 'display_clock_setting'],
  [0x200n, 'board_limit'],
  [0x400n, 'reliability'],
];

/**
 * Reasons that mean the GPU ran slower than it could because of power/heat/board limits, i.e. the
 * benchmark was throttled. gpu_idle, applications/display clock settings, sync_boost and
 * reliability (always on for some boards at idle) are informational.
 */
export const THROTTLE_REASONS: ReadonlySet<string> = new Set([
  'sw_power_cap',
  'hw_slowdown',
  'sw_thermal_slowdown',
  'hw_thermal_slowdown',
  'hw_power_brake_slowdown',
  'board_limit',
]);

/** Hex mask → reason names in bit order; unknown bits become "unknown_0x…"; placeholders → []. */
export function decodeClockEventReasons(cell: string | undefined): string[] {
  const m = /^\s*0x([0-9a-f]+)\s*$/i.exec(cell ?? '');
  if (!m?.[1]) return [];
  let mask = BigInt(`0x${m[1]}`);
  const out: string[] = [];
  for (const [bit, name] of CLOCK_EVENT_REASONS) {
    if (mask & bit) {
      out.push(name);
      mask &= ~bit;
    }
  }
  if (mask !== 0n) out.push(`unknown_0x${mask.toString(16)}`);
  return out;
}

/** true when any active reason is a real throttle (validity flag "throttling"). */
export function isThrottled(reasons: readonly string[]): boolean {
  return reasons.some((r) => THROTTLE_REASONS.has(r));
}
