/** "What is being measured right now", in words and numbers, from the core's run.step. */
import type { CurrentStep } from '../../../contract/events';
import type { EngineKind } from '../../../contract/engines';
import { fillsContext } from '../../../contract/results';
import type { Formatters } from '../../i18n';

type F = Pick<Formatters, 't' | 'integer'>;

/** How full the context is for a measurement that fills it step by step: context sweeps and a search's quick checks. */
const depthOf = (c: CurrentStep): number | undefined => (c.kind === 'context-sweep' || c.kind === 'tune-probe' || c.kind === 'tune-screen' ? (c.depth ?? c.promptTokens) : undefined);

/**
 * A measurement of a search's launch with its context full (`contextSize`: the context of the launch
 * in progress): where every speed of that combination is read, so the screen says when it happens.
 */
export function fillsLaunch(c: CurrentStep | undefined, contextSize: number | undefined): boolean {
  const depth = c && depthOf(c);
  return depth !== undefined && contextSize !== undefined && fillsContext(depth, contextSize);
}

/** Under a live speed measured with the launch's context full: "contesto pieno: 262.144 token" (else undefined). */
export function fullCaption(c: CurrentStep | undefined, contextSize: number | undefined, f: F): string | undefined {
  return c && fillsLaunch(c, contextSize) ? f.t('tune.live.gaugeFull', { tokens: f.integer(depthOf(c)!) }) : undefined;
}

/**
 * "Prompt di 4.096 token → 512 in uscita · ripetizione 3 di 10", "Contesto riempito fino a 32.768
 * token · riscaldamento 1 di 2", "8 utenti insieme · prompt di 512 token", "Caricamento a freddo 2 di 3".
 * `contextSize` (a search: its launch's context): "· contesto pieno" when the measurement fills it.
 */
export function nowText(c: CurrentStep, f: F, contextSize?: number): string {
  const { t, integer } = f;
  const parts: string[] = [];
  const full = fillsLaunch(c, contextSize) ? [t('tune.live.full')] : [];
  const prompt = (tokens: number) =>
    c.outputTokens === undefined ? t('run.now.prompt', { tokens: integer(tokens) }) : t('run.now.promptOut', { tokens: integer(tokens), output: integer(c.outputTokens) });
  switch (c.kind) {
    case 'load':
      parts.push(t(c.label === 'cold' ? 'run.now.loadCold' : c.label === 'warm' ? 'run.now.loadWarm' : 'run.now.load'));
      break;
    case 'first-token':
      parts.push(t('run.now.firstToken'));
      break;
    case 'context-sweep': {
      const depth = c.depth ?? c.promptTokens;
      parts.push(depth === undefined ? t('run.now.sweep') : t('run.now.depth', { tokens: integer(depth) }), ...full);
      if (c.outputTokens !== undefined) parts.push(t('run.now.output', { output: integer(c.outputTokens) }));
      break;
    }
    case 'concurrency':
      parts.push(c.concurrency === undefined ? t('run.now.usersAny') : c.concurrency === 1 ? t('run.now.userOne') : t('run.now.users', { n: c.concurrency }));
      if (c.promptTokens !== undefined) parts.push(t('run.now.usersPrompt', { tokens: integer(c.promptTokens) }));
      break;
    case 'sessions':
      parts.push(c.concurrency === undefined ? t('run.now.sessionsAny') : c.concurrency === 1 ? t('run.now.sessionOne') : t('run.now.sessions', { n: c.concurrency }));
      if (c.promptTokens !== undefined) parts.push(t('run.now.sessionsContext', { tokens: integer(c.promptTokens) }));
      if (c.turn !== undefined) parts.push(t('run.now.turn', { n: c.turn, total: c.turns ?? c.turn }));
      break;
    case 'llama-bench':
      parts.push(t('run.now.llamaBench'));
      break;
    default:
      // latency, the quick checks of a tune launch and the fidelity comparison: one prompt at a time.
      if (c.kind !== 'latency') parts.push(t(`run.now.${c.kind}`));
      if (c.promptTokens !== undefined) parts.push(prompt(c.promptTokens), ...full);
  }
  if (c.rep !== undefined) {
    const key = c.warmup ? (c.reps === undefined ? 'run.now.warmupN' : 'run.now.warmup') : c.reps === undefined ? 'run.now.repN' : 'run.now.rep';
    parts.push(t(key, { n: c.rep, total: c.reps ?? c.rep }));
  }
  return parts.join(' · ');
}

/** The engine family of a run label ("vLLM v0.12.0" / "llama.cpp b11438"), when the start request is not known. */
export function engineKindOfLabel(label: string): EngineKind {
  if (/tensorrt|trtllm/i.test(label)) return 'trtllm-docker';
  return /sglang/i.test(label) ? 'sglang-docker' : /vllm/i.test(label) ? 'vllm-docker' : 'llamacpp-native';
}
