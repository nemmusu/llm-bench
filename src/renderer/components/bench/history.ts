/** Run lists: speed history for sparklines, "this PC", and the filter options of the results page. */
import type { RunSummary } from '../../../contract/results';

/**
 * Generation speed of the same model on the same GPU over time, oldest first, up to `target`
 * included: the sparkline next to a result tells whether this run is in line with the others.
 */
export function decodeHistory(target: RunSummary, runs: readonly RunSummary[], max = 12): number[] {
  const at = Date.parse(target.createdAt);
  return runs
    .filter((r) => r.status === 'completed' && r.decodeTps !== undefined && r.modelWeakKey === target.modelWeakKey && r.gpuName === target.gpuName && Date.parse(r.createdAt) <= at)
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
    .slice(-max)
    .map((r) => r.decodeTps!);
}

export interface RunFilters {
  q: string;
  model: string;
  gpu: string;
  engine: string;
  status: string;
  thisPc: boolean;
}

export const ALL = 'all';

export const NO_FILTERS: RunFilters = { q: '', model: ALL, gpu: ALL, engine: ALL, status: ALL, thisPc: false };

/** `hostId`: this PC's id (/api/system), so "Solo questo PC" keeps the runs made here even if the PC was renamed. */
export function filterRuns(runs: readonly RunSummary[], f: RunFilters, hostId: string | undefined): RunSummary[] {
  const q = f.q.trim().toLowerCase();
  return runs.filter(
    (r) =>
      (!q || `${r.modelName} ${r.quant ?? ''} ${r.engineLabel} ${r.gpuName}`.toLowerCase().includes(q)) &&
      (f.model === ALL || r.modelName === f.model) &&
      (f.gpu === ALL || r.gpuName === f.gpu) &&
      (f.engine === ALL || r.engineKind === f.engine) &&
      (f.status === ALL || r.status === f.status) &&
      (!f.thisPc || r.hostId === hostId),
  );
}

/** Distinct values, sorted, for a filter select. */
export function distinct(runs: readonly RunSummary[], pick: (r: RunSummary) => string): string[] {
  return [...new Set(runs.map(pick))].sort((a, b) => a.localeCompare(b));
}
