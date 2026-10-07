/**
 * What the live screen knows about a run it did not start itself: kept in the query cache by the
 * start flow (survives navigation, not a reload; the live screen then falls back to the core's
 * /api/runs/active).
 */
import type { QueryClient } from '@tanstack/react-query';
import type { RunPlan, StartRunRequest } from '../../../contract/api';
import type { LaunchParams } from '../../../contract/engines';
import type { Profile, Scenario } from '../../../contract/results';
import type { PreSteps } from './phases';

export interface RunContext {
  request: StartRunRequest;
  plan?: RunPlan;
  modelLabel: string;
  engineLabel: string;
  pre: PreSteps;
  /** Date.now() when the run was started. */
  startedAt: number;
}

const key = (runId: string) => ['bench', 'run-context', runId] as const;

export function saveRunContext(qc: QueryClient, runId: string, ctx: RunContext): void {
  qc.setQueryDefaults(key(runId), { gcTime: Infinity, staleTime: Infinity });
  qc.setQueryData(key(runId), ctx);
}

export function readRunContext(qc: QueryClient, runId: string): RunContext | undefined {
  return qc.getQueryData<RunContext>(key(runId));
}

/** Where a preset comes from: shown by the Benchmark page's banner ("Preset da «…» del 07/10: …"). */
export interface PresetProvenance {
  runId: string;
  /** Index into the run's tuning.combinations. */
  combo?: number;
  /** The test, as its model is named ("Qwen3 8B · Q4_K_M"). */
  label: string;
  /** When the test ran (ISO). */
  date: string;
  /** Generation speed measured at `depth` tokens. */
  decodeTps?: number;
  depth?: number;
  /** Context the configuration was started with. */
  contextSize?: number;
}

/** A model to download first (hub GGUF, or a vLLM repo), when it is not on the PC any more. */
export interface DraftHubModel {
  repo: string;
  /** GGUF file in the repo; absent for a vLLM repo. */
  file?: string;
  revision: string;
  name: string;
  quant?: string;
  sizeBytes?: number;
  paramsB?: number;
}

/** Choices handed from a result ("Usa queste impostazioni", "Usa questo preset") to the Benchmark page, read once. */
export interface BenchDraft {
  engine: StartRunRequest['engine'];
  localId?: string;
  repo?: string;
  modelName?: string;
  profile: Profile;
  scenario?: Scenario;
  params?: LaunchParams;
  /** A preset's model that must be downloaded first. */
  hub?: DraftHubModel;
  provenance?: PresetProvenance;
}

const DRAFT_KEY = ['bench', 'draft'] as const;

export function saveDraft(qc: QueryClient, draft: BenchDraft): void {
  qc.setQueryDefaults(DRAFT_KEY, { gcTime: Infinity, staleTime: Infinity });
  qc.setQueryData(DRAFT_KEY, draft);
}

/** Returns the pending draft and forgets it. */
export function takeDraft(qc: QueryClient): BenchDraft | undefined {
  const d = qc.getQueryData<BenchDraft>(DRAFT_KEY);
  if (d) qc.removeQueries({ queryKey: DRAFT_KEY });
  return d;
}
