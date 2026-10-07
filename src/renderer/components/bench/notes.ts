/** Planning warnings (RunPlan.warnings) and run notes (RunResult.notes): codes → plain words. */
import type { Formatters, MessageKey, Params } from '../../i18n';
import { MIB_PER_GB } from './format';

export interface NoteLike {
  code: string;
  params?: Record<string, unknown> | undefined;
}

export const NOTE_CODES = [
  'prompt_too_long',
  'concurrency_level_skipped',
  'llama_bench_unsupported',
  'load_not_measurable',
  'partial_offload',
  'slow_shared_filesystem',
  'gpu_memory_reduced',
  'VRAM_BUSY',
  'MODEL_TOO_LARGE',
  'context_sweep_budget',
  'context_sweep_skipped',
  'sessions_depth_reduced',
  'sessions_depth_unknown',
  'sessions_budget',
] as const;
export type NoteCode = (typeof NOTE_CODES)[number];

export type NoteTone = 'info' | 'warning' | 'danger';

const TONES: Record<NoteCode, NoteTone> = {
  prompt_too_long: 'info',
  concurrency_level_skipped: 'info',
  llama_bench_unsupported: 'info',
  load_not_measurable: 'info',
  partial_offload: 'warning',
  slow_shared_filesystem: 'warning',
  gpu_memory_reduced: 'warning',
  VRAM_BUSY: 'warning',
  MODEL_TOO_LARGE: 'danger',
  context_sweep_budget: 'info',
  context_sweep_skipped: 'info',
  sessions_depth_reduced: 'info',
  sessions_depth_unknown: 'info',
  sessions_budget: 'info',
};

export interface NoteText {
  code: string;
  tone: NoteTone;
  title: string;
  body: string;
}

function isKnown(code: string): code is NoteCode {
  return (NOTE_CODES as readonly string[]).includes(code);
}

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const str = (v: unknown): string => (v === undefined || v === null ? '–' : String(v));

/** Interpolation values: numbers locale-formatted, MiB as GB, ratios as percent. */
function paramsFor(note: NoteLike, f: Pick<Formatters, 'integer' | 'number' | 'percent'>): Params {
  const p = note.params ?? {};
  const out: Params = {};
  for (const [k, v] of Object.entries(p)) {
    const n = num(v);
    if (n === undefined) out[k] = str(v);
    else if (k.endsWith('MiB')) out[k.slice(0, -3)] = `${f.number(n / MIB_PER_GB, 1)} GB`;
    else if (k === 'utilization') out.pct = f.percent(n, 0);
    else out[k] = f.integer(n);
  }
  return out;
}

/** Localized title + body for one note; unknown codes still say something useful. */
export function noteText(note: NoteLike, f: Pick<Formatters, 't' | 'integer' | 'number' | 'percent'>): NoteText {
  const params = paramsFor(note, f);
  if (!isKnown(note.code)) {
    return { code: note.code, tone: 'info', title: f.t('notes.unknown.title'), body: f.t('notes.unknown.body', { code: note.code }) };
  }
  // VRAM_BUSY has two flavours: known LLM servers, or anything holding the memory this model needs.
  // The context sweep is skipped when the context is unknown (external server) or too small for several depths.
  const variant =
    note.code === 'VRAM_BUSY' && params.need !== undefined
      ? 'VRAM_BUSY_MEMORY'
      : note.code === 'context_sweep_skipped' && params.reason === 'context_too_small'
        ? 'context_sweep_skipped_small'
        : note.code;
  return {
    code: note.code,
    tone: TONES[note.code],
    title: f.t(`notes.${variant}.title` as MessageKey, params),
    body: f.t(`notes.${variant}.body` as MessageKey, params),
  };
}
