/**
 * "In breve" of a one-user search: the five answers people asked for, in this order, each a number
 * with where it was measured and which configuration gave it:
 *   1. how fast it reads and writes at its largest context (the recommendation, the context full);
 *   2. at which context it reads fastest;  3. at which context it writes fastest;
 *   4. at which context it is best at both (tune-logic.ts balanceScore, said in a help tip);
 *   5. with the most precise KV cache that fits: how much context and how fast there.
 * What the search did not measure says "non misurata" instead of a number from elsewhere.
 */
import type { EngineKind } from '../../../contract/engines';
import type { LatencyPoint, Tuning } from '../../../contract/results';
import { useI18n, type Formatters } from '../../i18n';
import { tooltipHead } from '../../lib/speed-at';
import { prefillStat } from '../bench/format';
import { useConfigLabel } from '../presets/config-label';
import { HelpTip } from '../ui/help-tip';
import { comboText, depthLabel, kvName } from './tune-format';
import { briefOf, type BriefAtMax, type BriefPoint } from './tune-logic';

type F = Pick<Formatters, 't' | 'number' | 'integer'>;

interface Answer {
  key: string;
  label: string;
  help?: string;
  /** The number(s); undefined = not measured (`missing` says where). */
  value?: string;
  missing?: string;
  /** Exact tokens of the point, on hover. */
  title?: string;
  /** Which configuration, and anything to add. */
  detail: string;
}

const read = (p: LatencyPoint, f: F) => f.integer(prefillStat(p).median);
const write = (p: LatencyPoint, f: F) => f.number(p.decodeTps.median, 1);

/** "a 16K" or "a 40K, contesto pieno". */
function where(p: BriefPoint, f: F): string {
  const depth = depthLabel(p.depth, f);
  return p.full ? f.t('tune.brief.atFull', { depth }) : f.t('tune.brief.at', { depth });
}

/** The five answers, in words and numbers (pure: tests read them as they are shown). */
export function briefAnswers(tuning: Pick<Tuning, 'combinations' | 'recommended'>, kind: EngineKind, label: ReturnType<typeof useConfigLabel>, f: F): Answer[] {
  const b = briefOf(tuning);
  const { t } = f;
  const config = (c: { combo: BriefAtMax['combo'] }) => comboText(c.combo, kind, label);
  const both = (p: LatencyPoint) => t('tune.brief.readWrite', { read: read(p, f), write: write(p, f) });
  const out: Answer[] = [];
  if (b.atMax) {
    const ctx = depthLabel(b.atMax.combo.maxContext, f);
    const p = b.atMax.point;
    out.push({
      key: 'atMax',
      label: t('tune.brief.atMax', { ctx }),
      help: t('tune.brief.atMaxHelp'),
      ...(p ? { value: both(p), title: tooltipHead(p.promptTokens, 'depth', f) } : { missing: t('tune.brief.notMeasured', { ctx }) }),
      detail: config(b.atMax),
    });
  }
  const at = (key: 'read' | 'write' | 'both', p: BriefPoint | undefined, value: (p: LatencyPoint) => string, help?: string) => {
    if (!p) return;
    out.push({ key, label: t(`tune.brief.${key}`), ...(help ? { help } : {}), value: `${where(p, f)}: ${value(p.point)}`, title: tooltipHead(p.point.promptTokens, 'depth', f), detail: config(p) });
  };
  at('read', b.read, (p) => `${read(p, f)} tok/s`);
  at('write', b.write, (p) => `${write(p, f)} tok/s`);
  at('both', b.both, both, t('tune.brief.bothHelp'));
  if (b.quality) {
    const q = b.quality;
    const ctx = depthLabel(q.combo.maxContext, f);
    const kv = kvName(q.combo.kvType, f);
    out.push({
      key: 'quality',
      label: t('tune.brief.quality', { kv }),
      help: t('tune.brief.qualityHelp'),
      ...(q.point ? { value: t('tune.brief.qualityValue', { ctx, read: read(q.point, f), write: write(q.point, f) }), title: tooltipHead(q.point.promptTokens, 'depth', f) } : { missing: t('tune.brief.qualityNotMeasured', { ctx }) }),
      detail: [config(q), ...(q.below8 ? [t('tune.brief.below8', { kv })] : [])].join(' · '),
    });
  }
  return out;
}

/** The answers as a numbered list: the question, the number(s) and where, the configuration. */
export function TuneBrief({ tuning, engineKind }: { tuning: Tuning; engineKind: EngineKind }) {
  const f = useI18n();
  const label = useConfigLabel();
  const answers = briefAnswers(tuning, engineKind, label, f);
  if (!answers.length) return null;
  return (
    <ol aria-label={f.t('tune.brief.title')} className="mt-4 grid gap-3 @3xl:grid-cols-2 @6xl:grid-cols-3">
      {answers.map((a, i) => (
        <li key={a.key} className="flex gap-3 rounded-lg border border-border bg-surface/70 p-4">
          <span aria-hidden className="grid size-6 shrink-0 place-items-center rounded-full bg-accent-soft text-xs font-semibold text-accent-text tabular-nums">
            {i + 1}
          </span>
          <div className="flex min-w-0 flex-col gap-1">
            <p className="inline-flex items-center gap-1 text-sm font-medium text-fg-2">
              {a.label}
              {a.help && <HelpTip term={a.label}>{a.help}</HelpTip>}
            </p>
            {a.value !== undefined ? (
              <p className="text-lg leading-6 font-semibold text-fg tabular-nums" title={a.title}>
                {a.value}
              </p>
            ) : (
              <p className="text-md font-medium text-fg-3 italic">{a.missing}</p>
            )}
            <p className="text-xs text-fg-3">{a.detail}</p>
          </div>
        </li>
      ))}
    </ol>
  );
}
