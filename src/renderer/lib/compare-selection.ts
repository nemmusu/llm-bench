/**
 * What the user picked to compare: up to four runs, or single combinations of a "Trova le
 * impostazioni migliori" run. The same list behind every "Confronta" button and the tray at the bottom
 * of the window; it stays while moving between pages (and across restarts). The comparison itself
 * lives in the address (/compare?ids=…), so it can be shared and reopened as it is.
 *
 *   address token: "<runId>" or "<runId>~<combination>"   e.g. "01K6Y7Q2ZC4M8N3B5V9R1T0XWE~2"
 */
import { useSyncExternalStore } from 'react';

/** Most things compared at once. */
export const COMPARE_MAX = 4;

export interface CompareRef {
  runId: string;
  /** Index into run.tuning.combinations. */
  combo?: number;
}

/** A picked item, with what the tray shows about it. */
export interface CompareEntry extends CompareRef {
  /** "Qwen3 8B · Q4_K_M". */
  label: string;
  /** "llama.cpp b11438 · cache KV q4_0". */
  detail?: string;
  /** When the test ran (ISO): items open oldest first, like a before/after. */
  createdAt?: string;
}

const TOKEN = /^([A-Za-z0-9_-]+)(?:~(\d{1,3}))?$/;

/** "<runId>" or "<runId>~<combination>". */
export function refToken(r: CompareRef): string {
  return r.combo === undefined ? r.runId : `${r.runId}~${r.combo}`;
}

export function parseToken(text: string): CompareRef | undefined {
  const m = TOKEN.exec(text.trim());
  if (!m) return undefined;
  return m[2] === undefined ? { runId: m[1]! } : { runId: m[1]!, combo: Number(m[2]) };
}

/** The items of an address ("A,B~2,C"): valid tokens only, each once, at most four. */
export function parseIds(ids: string | undefined): CompareRef[] {
  const out: CompareRef[] = [];
  for (const part of (ids ?? '').split(',')) {
    const ref = parseToken(part);
    if (ref && !out.some((r) => sameRef(r, ref)) && out.length < COMPARE_MAX) out.push(ref);
  }
  return out;
}

export function idsOf(refs: readonly CompareRef[]): string {
  return refs.map(refToken).join(',');
}

export function sameRef(a: CompareRef, b: CompareRef): boolean {
  return a.runId === b.runId && a.combo === b.combo;
}

/** Adds the item, or takes it away when it is there already; a full list stays as it is (`full`). */
export function toggleEntry<T extends CompareRef>(list: readonly T[], item: T): { list: T[]; full: boolean } {
  if (list.some((r) => sameRef(r, item))) return { list: list.filter((r) => !sameRef(r, item)), full: false };
  if (list.length >= COMPARE_MAX) return { list: [...list], full: true };
  return { list: [...list, item], full: false };
}

/** Oldest first (unknown dates keep their place at the end): an older test reads as "before". */
export function oldestFirst<T extends Pick<CompareEntry, 'createdAt'>>(list: readonly T[]): T[] {
  const at = (e: T) => (e.createdAt ? Date.parse(e.createdAt) : Infinity);
  return [...list].sort((a, b) => at(a) - at(b));
}

// ---- the shared list (one per window), kept in localStorage ---------------------------------------

const KEY = 'gpubench.compare';

function read(): CompareEntry[] {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    if (!Array.isArray(raw)) return [];
    return raw.filter((e): e is CompareEntry => !!e && typeof e === 'object' && typeof e.runId === 'string' && typeof e.label === 'string').slice(0, COMPARE_MAX);
  } catch {
    return [];
  }
}

// Read on first use, not when the module loads (the storage of a test or a fresh window may not be ready yet).
let state: CompareEntry[] | undefined;
const listeners = new Set<() => void>();
const current = (): CompareEntry[] => (state ??= read());

/** Replaces the whole list (the compare page, "Svuota"). */
export function setCompareSelection(next: readonly CompareEntry[]): void {
  state = next.slice(0, COMPARE_MAX);
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    // Storage unavailable: the list lives as long as the window.
  }
  for (const l of listeners) l();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const snapshot = current;

export interface CompareSelection {
  items: readonly CompareEntry[];
  has: (ref: CompareRef) => boolean;
  /** 'added', 'removed', or 'full' (four already: nothing changed). */
  toggle: (entry: CompareEntry) => 'added' | 'removed' | 'full';
  remove: (ref: CompareRef) => void;
  clear: () => void;
}

export function useCompareSelection(): CompareSelection {
  const items = useSyncExternalStore(subscribe, snapshot);
  return {
    items,
    has: (ref) => items.some((r) => sameRef(r, ref)),
    toggle: (entry) => {
      const had = current().some((r) => sameRef(r, entry));
      const next = toggleEntry(current(), entry);
      if (next.full) return 'full';
      setCompareSelection(next.list);
      return had ? 'removed' : 'added';
    },
    remove: (ref) => setCompareSelection(current().filter((r) => !sameRef(r, ref))),
    clear: () => setCompareSelection([]),
  };
}
