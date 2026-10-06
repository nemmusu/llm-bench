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

/** Choices handed from a result ("Usa queste impostazioni") to the Benchmark page, read once. */
export interface BenchDraft {
  engine: StartRunRequest['engine'];
  localId?: string;
  repo?: string;
  modelName?: string;
  profile: Profile;
  scenario?: Scenario;
  params?: LaunchParams;
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
