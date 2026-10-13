/**
 * Speed ↔ context, in the same words everywhere. A tok/s number never travels alone: it says which
 * way the text went (read = prompt reading / prefill, written = generation) and how much text was in
 * the context when it was measured.
 *
 *   speedAt(54.6, { kind: 'write', tokens: 32768 }, f)  → "54,6 tok/s · scrittura con 32.768 token già nel contesto"
 *   speedAt(2244, { kind: 'read', tokens: 512 }, f)     → "2.244 tok/s · lettura di un prompt da 512 token"
 *   contextShort({ kind: 'write', tokens: 32768 }, f)   → "a 32K di contesto"            (a cell's second line)
 *   headerAt('Generazione (tok/s)', 32768, f)           → "Generazione (tok/s) a 32K"     (a column header)
 *   pointTooltip(32768, 'depth', { write: 54.6, read: 2244 }, f)
 *                                                       → "a 32.768 token di contesto: scrittura 54,6 tok/s, lettura 2.244 tok/s"
 *
 * Where the context comes from (`basis`):
 *  - 'prompt' (the latency step, "Per lunghezza del prompt"): the context read IS the prompt;
 *  - 'depth' (the context sweep and the tuner, "Contesto per gradi"): the context was filled to that
 *    depth before writing.
 * Writing always happens with that many tokens already in the context, so its words are the same for
 * both; only reading says "un prompt da N token" or "il contesto fino a N token".
 */
import type { CurrentStep } from '../../contract/events';
import type { Formatters } from '../i18n';

/** Generation (writing) or prompt reading (prefill). */
export type SpeedKind = 'write' | 'read';
/** A prompt of that length (latency step), or a context filled to that depth (context sweep, tuner). */
export type ContextBasis = 'prompt' | 'depth';

export interface SpeedContext {
  kind: SpeedKind;
  /** Tokens in the context: the prompt length, or how full the context was. */
  tokens: number;
  /** Default 'prompt'. */
  basis?: ContextBasis;
}

type F = Pick<Formatters, 't' | 'number' | 'integer'>;

const K = 1024;

/** "54,6 tok/s" (writing, one decimal) or "2.244 tok/s" (reading, whole numbers). */
export function tpsText(kind: SpeedKind, value: number, f: Pick<Formatters, 'number' | 'integer'>): string {
  return `${kind === 'write' ? f.number(value, 1) : f.integer(value)} tok/s`;
}

/** Short token counts with their unit: 512 → "512 token", 32768 → "32K", 4864 → "4,8K" (K = 1024 tokens). */
export function tokensK(n: number, f: F): string {
  if (n < K) return f.t('speedAt.tokens', { n: f.integer(n) });
  return n % K === 0 ? `${f.integer(n / K)}K` : `${f.number(n / K, 1)}K`;
}

/** "scrittura con 32.768 token già nel contesto", "lettura di un prompt da 512 token", "lettura del contesto fino a 32.768 token". */
export function contextWords(c: SpeedContext, f: F): string {
  const tokens = f.integer(c.tokens);
  if (c.kind === 'write') return f.t('speedAt.write', { tokens });
  return f.t(c.basis === 'depth' ? 'speedAt.readDepth' : 'speedAt.readPrompt', { tokens });
}

/** The whole thing: "54,6 tok/s · scrittura con 32.768 token già nel contesto". */
export function speedAt(value: number, c: SpeedContext, f: F): string {
  return f.t('speedAt.full', { value: tpsText(c.kind, value, f), context: contextWords(c, f) });
}

/** A cell's second line: "a 32K di contesto", "a 512 token di contesto", "prompt da 8K". */
export function contextShort(c: SpeedContext, f: F): string {
  const tokens = tokensK(c.tokens, f);
  return f.t(c.kind === 'read' && c.basis !== 'depth' ? 'speedAt.shortPrompt' : 'speedAt.shortContext', { tokens });
}

/** A column header with the context every row shares: "Generazione (tok/s) a 32K". */
export function headerAt(label: string, tokens: number, f: F): string {
  return f.t('speedAt.header', { label, tokens: tokensK(tokens, f) });
}

/** The x axis of a speed chart: "Token già nel contesto" or "Lunghezza del prompt (token)". */
export function axisName(basis: ContextBasis, f: Pick<Formatters, 't'>): string {
  return f.t(basis === 'depth' ? 'speedAt.axisDepth' : 'speedAt.axisPrompt');
}

/** The head of a tooltip: "a 32.768 token di contesto", "prompt da 512 token". */
export function tooltipHead(tokens: number, basis: ContextBasis, f: F): string {
  return f.t(basis === 'depth' ? 'speedAt.tooltipDepth' : 'speedAt.tooltipPrompt', { tokens: f.integer(tokens) });
}

/** "a 32.768 token di contesto: scrittura 54,6 tok/s, lettura 2.244 tok/s" (only the speeds it has). */
export function pointTooltip(tokens: number, basis: ContextBasis, speeds: { write?: number | undefined; read?: number | undefined }, f: F): string {
  const parts = [
    speeds.write === undefined ? undefined : f.t('speedAt.writeValue', { value: tpsText('write', speeds.write, f) }),
    speeds.read === undefined ? undefined : f.t('speedAt.readValue', { value: tpsText('read', speeds.read, f) }),
  ].filter((p): p is string => p !== undefined);
  const head = tooltipHead(tokens, basis, f);
  return parts.length ? `${head}: ${parts.join(', ')}` : head;
}

/** The context of a first-token time: "dopo un prompt da 512 token", "con 32.768 token di contesto". */
export function firstTokenWords(tokens: number, basis: ContextBasis, f: F): string {
  return f.t(basis === 'depth' ? 'speedAt.firstDepth' : 'speedAt.firstPrompt', { tokens: f.integer(tokens) });
}

/** Several users at once: "con 4 utenti insieme, prompt da 512 token ciascuno" (the prompt when known). */
export function usersWords(users: number, promptTokens: number | undefined, f: F): string {
  if (promptTokens === undefined) return f.t(users === 1 ? 'speedAt.usersOne' : 'speedAt.users', { n: users });
  return f.t(users === 1 ? 'speedAt.usersOnePrompt' : 'speedAt.usersPrompt', { n: users, tokens: f.integer(promptTokens) });
}

/**
 * The caption under a live gauge: what the number on it was measured on. "prompt da 4.096 token",
 * "contesto riempito a 32.768 token", "in tutto, con 8 utenti". undefined when the step says nothing.
 */
export function liveCaption(step: CurrentStep | undefined, f: F): string | undefined {
  if (!step) return undefined;
  if (step.kind === 'concurrency') return step.concurrency === undefined ? undefined : f.t('speedAt.gaugeUsers', { n: step.concurrency });
  if (step.kind === 'sessions') return step.promptTokens === undefined ? undefined : f.t('speedAt.gaugeDepth', { tokens: f.integer(step.promptTokens) });
  if (step.kind === 'context-sweep') {
    const depth = step.depth ?? step.promptTokens;
    return depth === undefined ? undefined : f.t('speedAt.gaugeDepth', { tokens: f.integer(depth) });
  }
  return step.promptTokens === undefined ? undefined : f.t('speedAt.gaugePrompt', { tokens: f.integer(step.promptTokens) });
}
