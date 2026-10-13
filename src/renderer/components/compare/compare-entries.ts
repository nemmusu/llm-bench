/** What the tray says about a picked run, combination or configuration: the model, then engine, settings and date. */
import type { ConfigEntry } from '../../../contract/configs';
import type { RunResult, RunSummary } from '../../../contract/results';
import type { Formatters } from '../../i18n';
import type { CompareEntry } from '../../lib/compare-selection';
import { modelLabelOf, prettyEngineLabel, summaryModelLabel } from '../bench/format';
import { configEngineLabel } from '../configs/engine-label';
import { configLabelOf } from '../presets/config-label';
import { shortDate } from '../presets/format';
import { refOfConfig } from './best-config';
import { engineName } from './compare-model';

type F = Pick<Formatters, 't' | 'integer' | 'number' | 'percent' | 'locale'>;

/** A row of Risultati. */
export function entryOfSummary(r: RunSummary, f: F): CompareEntry {
  return { runId: r.id, label: summaryModelLabel(r), detail: `${prettyEngineLabel(r.engineLabel)} · ${shortDate(r.createdAt, f.locale)}`, createdAt: r.createdAt };
}

/** A whole run, or one combination of a tune run. */
export function entryOfRun(run: RunResult, combo: number | undefined, f: F): CompareEntry {
  const parts = [engineName(run.engine, f), ...(combo === undefined ? [] : [f.t('compare.card.combo', { n: combo + 1 })]), shortDate(run.createdAt, f.locale)];
  return { runId: run.id, ...(combo === undefined ? {} : { combo }), label: modelLabelOf(run.model), detail: parts.join(' · '), createdAt: run.createdAt };
}

/** A configuration of Configurazioni: the test that measured it at `depth` (the newest one). */
export function entryOfConfig(e: ConfigEntry, depth: number | undefined, f: F): CompareEntry {
  const ref = refOfConfig(e, depth);
  const source = e.sources.find((s) => s.runId === ref.runId && s.combo === ref.combo)!;
  const words = configLabelOf(e.engineKind, e.params, f, { tags: e.tags }).text;
  return {
    ...ref,
    label: summaryModelLabel({ modelName: e.model.name, quant: e.model.quant }),
    detail: [configEngineLabel(e), words].filter(Boolean).join(' · '),
    createdAt: source.date,
  };
}
