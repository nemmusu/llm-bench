import type { RunResult } from '../../../contract/results';
import { useI18n } from '../../i18n';
import { Card, CardHeader, CardTitle } from '../ui/card';
import { HelpTip } from '../ui/help-tip';
import { SimpleTable } from './result-details';
import { kvCapacityText, sessionsGlossary, sessionsOf, sessionsSentences, sessionsTable } from './sessions-view';

/** "Contesto tenuto in memoria: 889.820 token (bastano per 4 conversazioni da 200.000)". */
function KvCapacityLine({ run }: { run: RunResult }) {
  const f = useI18n();
  const kv = run.metrics.kvCapacity!;
  return (
    <p className="flex flex-wrap items-center gap-x-1.5 text-sm text-fg-2">
      <span className="font-medium text-fg">{f.t('longConversations.kv.label')}:</span>
      <span className="tabular-nums">{kvCapacityText(kv, f)}</span>
      <HelpTip term={f.t('longConversations.kv.label')}>{f.t('longConversations.kv.help')}</HelpTip>
    </p>
  );
}

/**
 * "Conversazioni lunghe": sentences with the numbers, a table by conversations at once (every unit
 * in the headers, empty columns left out) and a short glossary. With only the KV capacity known,
 * just that line.
 */
export function LongConversations({ run }: { run: RunResult }) {
  const f = useI18n();
  const { t } = f;
  const points = sessionsOf(run);
  const kv = run.metrics.kvCapacity;
  if (points.length === 0) {
    return kv ? (
      <Card className="px-card py-4">
        <KvCapacityLine run={run} />
      </Card>
    ) : null;
  }
  const table = sessionsTable(points, f);
  const sentences = sessionsSentences(points, f);
  return (
    <Card className="overflow-hidden" role="region" aria-labelledby="long-conversations-title">
      <CardHeader className="flex-col gap-2 pb-3">
        <CardTitle id="long-conversations-title" className="flex items-center gap-1.5">
          {t('longConversations.title')}
          <HelpTip term={t('longConversations.title')}>{t('longConversations.help')}</HelpTip>
        </CardTitle>
        {kv && <KvCapacityLine run={run} />}
        {sentences.length > 0 && (
          <ul className="flex list-none flex-col gap-1 text-sm leading-6 text-fg">
            {sentences.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ul>
        )}
      </CardHeader>
      <SimpleTable caption={t('longConversations.caption')} head={table.head} rows={table.rows} />
      <div className="flex flex-col gap-3 px-card py-4 text-sm">
        {table.estimated && <p className="text-xs text-fg-3">{t('longConversations.estimatedNote')}</p>}
        <h3 className="text-xs font-semibold tracking-wide text-fg-3 uppercase">{t('longConversations.glossaryTitle')}</h3>
        <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-[max-content_1fr]">
          {sessionsGlossary(f).map((g) => (
            <div key={g.term} className="contents">
              <dt className="font-medium text-fg">{g.term}</dt>
              <dd className="text-fg-2">{g.text}</dd>
            </div>
          ))}
        </dl>
        <p className="text-fg-2">{t('longConversations.proportional')}</p>
      </div>
    </Card>
  );
}
