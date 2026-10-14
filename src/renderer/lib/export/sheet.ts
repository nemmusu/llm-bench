/**
 * "Scheda da condividere": a well-written page about a server, for the team that uses it. Built from
 * one result (and, from the Compare page, everything it was compared with): the model and the
 * configuration in words, the exact command, how fast it reads and writes, what long conversations
 * wait, what the cache saves, how the queue works, how much context the memory holds, the comparison
 * in words and a glossary. Never any secret: commands are stored redacted, and every text is scrubbed again.
 * A "Trova le impostazioni migliori" result is about its recommended combination (or the one compared):
 * its settings, its command and its speeds with the context full.
 */
import { contextTokensOf, promptsCalibrated, type RunResult } from '../../../contract/results';
import { compareRows, engineName, rowLead, type CompareItem } from '../../components/compare/compare-model';
import type { CompareAt } from '../../components/configs/depths';
import { engineLabelOf, headlinePoint, MIB_PER_GB, modelLabelOf, prefillStat, shortGpuName, slug } from '../../components/bench/format';
import { tuneHeadline, type TuneHeadline } from '../../components/bench/kpis';
import { launchLabelOf } from '../../components/presets/config-label';
import { kvCapacityText, sessionsGlossary, sessionsOf, sessionsRows, sessionsSentences, sessionsTable, soloPoint } from '../../components/bench/sessions-view';
import type { Formatters } from '../../i18n';
import { tokensK } from '../speed-at';
import { reportToHtml } from './html';
import { reportToMarkdown } from './markdown';
import type { Report, ReportSection } from './report';
import type { SaveRequest } from './save';

/** The Compare page's items (2–4), their names ("A · Qwen3 8B") and where they are compared ("Confronta a"). */
export interface SheetCompare {
  items: readonly CompareItem[];
  names: readonly string[];
  at?: CompareAt | undefined;
  /** The item the sheet is about (its run is SheetInput.run). */
  subject: number;
}

export interface SheetInput {
  /** The result the sheet is about (in a comparison: the item chosen in the dialog). */
  run: RunResult;
  /** A search's combination the sheet is about (in a comparison: the one compared); default: its recommended one. */
  combo?: number | undefined;
  /** From the Compare page: every item, the one the sheet is about included. */
  compare?: SheetCompare;
  /** Typed by the user in the export dialog (all optional). */
  service?: string;
  address?: string;
  notes?: string;
  /** LLM Bench version that writes the sheet. */
  appVersion: string;
  now: Date;
}

export const SHEET_FORMATS = ['markdown', 'html'] as const;
export type SheetFormat = (typeof SHEET_FORMATS)[number];

/**
 * Hides anything that looks like a secret: Hugging Face tokens, API keys (sk-…, --api-key value,
 * Bearer …, ?api_key=/token= in URLs) and passwords in URLs (user:pass@).
 */
export function redactSecrets(text: string): string {
  return text
    .replace(/\bhf_[A-Za-z0-9]{8,}\b/g, '<HF_TOKEN>')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, '<API_KEY>')
    .replace(/(--api-key[=\s]+)(?!<)(\S+)/gi, '$1<API_KEY>')
    .replace(/(Bearer\s+)(?!<)(\S+)/gi, '$1<API_KEY>')
    .replace(/([?&](?:api[_-]?key|access[_-]?token|token|key|password)=)[^&#\s]+/gi, '$1<REDACTED>')
    .replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^/\s@]+@/gi, '$1');
}

function scrub(report: Report): Report {
  const r = redactSecrets;
  return {
    title: r(report.title),
    meta: report.meta.map(r),
    ...(report.sentence ? { sentence: r(report.sentence) } : {}),
    sections: report.sections.map((s) => ({
      title: r(s.title),
      ...(s.text ? { text: r(s.text) } : {}),
      ...(s.paragraphs ? { paragraphs: s.paragraphs.map(r) } : {}),
      ...(s.definitions ? { definitions: s.definitions.map((d) => ({ term: r(d.term), text: r(d.text) })) } : {}),
      ...(s.after ? { after: s.after.map(r) } : {}),
      ...(s.table ? { table: { ...s.table, head: s.table.head.map(r), rows: s.table.rows.map((row) => row.map(r)) } } : {}),
      ...(s.code ? { code: { powershell: r(s.code.powershell), bash: r(s.code.bash) } } : {}),
    })),
    footer: r(report.footer),
  };
}

/** "8 miliardi di parametri · Q4_K_M · 8 esperti attivi su 128 · contesto fino a 131.072 token". */
export function modelInWords(run: RunResult, f: Pick<Formatters, 't' | 'integer' | 'number'>): string {
  const { t, integer, number } = f;
  const m = run.model;
  const x = m.facts;
  const parts: string[] = [];
  if (x?.paramsB !== undefined) parts.push(t('sheet.model.params', { n: number(x.paramsB, x.paramsB < 10 ? 1 : 0) }));
  if (m.quant) parts.push(m.quant);
  if (x?.expertCount && x.expertUsedCount) parts.push(t('sheet.model.experts', { used: x.expertUsedCount, total: x.expertCount }));
  if (x?.contextLength) parts.push(t('sheet.model.context', { n: integer(x.contextLength) }));
  return parts.join(' · ');
}

/** Facts about the machine, without its name (the sheet may travel). */
function machine(run: RunResult, f: Pick<Formatters, 'integer' | 'bytes'>): { gpu: string; pc: string } {
  const gpu = run.hardware.gpus[0];
  const hw = run.hardware;
  return {
    gpu: gpu ? `${gpu.name} · ${f.integer(gpu.memoryTotalMiB / MIB_PER_GB)} GB${gpu.driverVersion ? ` · driver ${gpu.driverVersion}` : ''}` : '–',
    pc: [hw.cpu.model, `${f.bytes(hw.ramBytes)} RAM`, hw.os.name].filter((p) => p && p !== 'unknown').join(' · '),
  };
}

function speedSections(run: RunResult, tuned: TuneHeadline | undefined, f: Formatters): ReportSection[] {
  const { t, integer, number, duration } = f;
  const out: ReportSection[] = [];
  const points = sessionsOf(run);
  if (points.length) {
    const table = sessionsTable(points, f);
    out.push({
      title: t('sheet.sections.speed'),
      paragraphs: [...sessionsSentences(points, f), ...(table.estimated ? [t('longConversations.estimatedNote')] : [])],
      table: { head: table.head, rows: table.rows, numericFrom: 0 },
    });
    const rows = sessionsRows(points);
    const reuse = rows.filter((r) => r.reuse !== undefined);
    const solo = rows.find((r) => r.sessions === 1);
    if (solo?.firstWaitMs !== undefined && solo.laterWaitMs !== undefined) {
      const from = duration(solo.firstWaitMs);
      const to = duration(solo.laterWaitMs);
      const shares = reuse.map((r) => t(r.sessions === 1 ? 'sheet.cache.shareOne' : 'sheet.cache.share', { reuse: f.percent(r.reuse as number, 1), n: r.sessions })).join(', ');
      out.push({ title: t('sheet.sections.cache'), text: reuse.length ? t('sheet.cache.body', { shares, from, to }) : t('sheet.cache.unknown', { from, to }) });
    }
    // Levels are stored in ascending order.
    const queued = points.filter((p) => p.sessions > 1 && p.firstTurn.queueWaitMs.n > 0);
    if (queued.length) {
      const alone = soloPoint(points);
      const paragraphs = queued.map((p) => {
        const params = {
          n: p.sessions,
          rate: integer(p.firstTurn.prefillTps.median),
          queue: duration(p.firstTurn.queueWaitMs.max),
          estimated: p.queueEstimated ? ` (${t('longConversations.estimated')})` : '',
        };
        return alone && alone.firstTurn.prefillTps.n > 0 ? t('sheet.queue.body', { ...params, solo: integer(alone.firstTurn.prefillTps.median) }) : t('sheet.queue.bodyNoSolo', params);
      });
      out.push({ title: t('sheet.sections.queue'), paragraphs });
    }
    return out;
  }
  // No long conversations measured: the basic speeds of a single request.
  const p = headlinePoint(run.metrics.latency);
  if (p) {
    out.push({
      title: t('sheet.sections.speed'),
      table: {
        head: [t('sheet.basic.prompt'), t('sheet.basic.read'), t('sheet.basic.firstWait'), t('sheet.basic.write')],
        rows: [[integer(p.promptTokens), integer(prefillStat(p).median), duration(p.ttftMs.median), number(p.decodeTps.median, 1)]],
        numericFrom: 0,
      },
    });
  } else if (tuned) {
    // A search: one request with the context full (where it reads the speeds), or as full as it got.
    const q = tuned.point;
    const tokens = integer(contextTokensOf(q, promptsCalibrated(run)));
    out.push({
      title: t('sheet.sections.speed'),
      table: {
        head: [t('sheet.basic.depth'), t('sheet.basic.read'), t('sheet.basic.firstWait'), t('sheet.basic.write')],
        rows: [[tuned.full ? t('sheet.basic.depthFull', { n: tokens }) : tokens, integer(prefillStat(q).median), duration(q.ttftMs.median), number(q.decodeTps.median, 1)]],
        numericFrom: 0,
      },
      ...(tuned.full ? {} : { after: [t('sheet.basic.notFull', { ctx: tokensK(tuned.combo.maxContext, f), depth: tokensK(q.promptTokens, f) })] }),
    });
  }
  return out;
}

/**
 * "Confronto": every compared item in one table, the speeds where the page compares them (said in the
 * row; at "Contesto massimo" each number says its own context), and who does best against the
 * runner-up, in words. A number with no winner, or not measured, says so as the page does.
 */
function comparisonSection(c: SheetCompare, f: Formatters): ReportSection {
  const { t, dateTime } = f;
  const rows = compareRows(c.items, c.at, f).map((r) => {
    const lead = rowLead(r, f);
    const where = (i: number) => (r.compared ? ` (${tokensK(c.items[i]!.full!.depth, f)}${r.compared[i] ? '' : `, ${t('compare.smallerContext')}`})` : '');
    const cell = (v: number | undefined, i: number) =>
      v === undefined ? (r.missing?.[i] ?? '–') : r.reread?.[i] ? `${t('longConversations.compare.reread')} (${r.format(v)})` : `${r.format(v)}${where(i)}`;
    const who = !lead ? '–' : lead.tie ? t('compare.same') : t('sheet.compare.lead', { name: c.names[lead.winner]!, diff: lead.diff });
    return [r.context ? `${r.label} · ${r.context}` : r.label, ...r.values.map(cell), who];
  });
  const same = c.items.every((it) => it.run.hardware.hostId === c.items[0]!.run.hardware.hostId && it.run.model.weakKey === c.items[0]!.run.model.weakKey);
  const config = (it: CompareItem) => launchLabelOf(it.params, it.run.engine.kind, f, { blockCount: it.run.model.facts?.blockCount, tags: it.combo?.tags }).text;
  return {
    title: t('sheet.sections.compare'),
    text: t(same ? 'sheet.compare.sameMachine' : 'sheet.compare.intro', { n: c.items.length }),
    paragraphs: c.items.map((it, i) =>
      t(i === c.subject ? 'sheet.compare.itemThis' : 'sheet.compare.item', { name: c.names[i]!, engine: engineName(it.run.engine, f), config: config(it), date: dateTime(it.run.createdAt) }),
    ),
    table: { head: [t('sheet.compare.metric'), ...c.names, t('sheet.compare.best')], rows, numericFrom: 1 },
  };
}

export function sheetOf(input: SheetInput, f: Formatters): Report {
  const { t, integer, dateTime } = f;
  const { run } = input;
  const service = input.service?.trim();
  const address = input.address?.trim();
  const notes = input.notes?.trim();
  const m = machine(run, f);
  const model = modelLabelOf(run.model);
  const sections: ReportSection[] = [];
  // A search is used through a combination: its settings and its command, not the search's last launch.
  const tuned = tuneHeadline(run, input.combo);
  const launch = tuned ? { params: tuned.combo.params, display: { powershell: tuned.combo.command.powershell, bash: tuned.combo.command.bash } } : run.launch;

  if (service || address || notes) {
    sections.push({
      title: t('sheet.sections.service'),
      ...(service || address
        ? {
            table: {
              head: [t('sheet.facts.what'), t('sheet.facts.value')],
              numericFrom: 99,
              rows: [...(service ? [[t('sheet.facts.service'), service]] : []), ...(address ? [[t('sheet.facts.address'), address]] : [])],
            },
          }
        : {}),
      ...(notes ? { after: notes.split(/\r?\n\s*\r?\n/).map((p) => p.replace(/\s*\r?\n\s*/g, ' ')) } : {}),
    });
  }

  sections.push({
    title: t('sheet.sections.setup'),
    table: {
      head: [t('sheet.facts.what'), t('sheet.facts.value')],
      numericFrom: 99,
      rows: [
        [t('sheet.facts.model'), [model, modelInWords(run, f)].filter(Boolean).join(' — ')],
        [t('sheet.facts.engine'), engineLabelOf(run.engine) + (run.engine.image ? ` · ${run.engine.image}` : '')],
        [t('sheet.facts.gpu'), m.gpu],
        [t('sheet.facts.pc'), m.pc],
        // The same words as the rest of the app (Risultati → Configurazioni, the result header).
        [t('sheet.facts.launch'), launchLabelOf(launch.params, run.engine.kind, f, { blockCount: run.model.facts?.blockCount, tags: tuned?.combo.tags }).text],
      ],
    },
    after: [t('sheet.facts.commandIntro')],
    code: launch.display,
  });

  sections.push(...speedSections(run, tuned, f));
  if (run.metrics.kvCapacity) {
    sections.push({ title: t('sheet.sections.memory'), text: t('sheet.memory.body', { value: kvCapacityText(run.metrics.kvCapacity, f) }) });
  }
  if (input.compare) sections.push(comparisonSection(input.compare, f));
  if (sessionsOf(run).length) {
    sections.push({ title: t('sheet.sections.glossary'), definitions: sessionsGlossary(f), after: [t('longConversations.proportional')] });
  }

  const solo = soloPoint(sessionsOf(run));
  const p = headlinePoint(run.metrics.latency);
  const who = { model, engine: engineLabelOf(run.engine), gpu: shortGpuName(run.hardware.gpus[0]?.name ?? '–') };
  const sentence = solo?.aggregatePrefillTps !== undefined
    ? t('sheet.summary.sessions', { ...who, read: integer(solo.aggregatePrefillTps), write: f.number(solo.firstTurn.decodeTps.median, 1), depth: integer(solo.depth) })
    : p
      ? t('sheet.summary.basic', { ...who, read: integer(prefillStat(p).median), write: f.number(p.decodeTps.median, 1) })
      : tuned
        ? t(tuned.full ? 'sheet.summary.tuneFull' : 'sheet.summary.tuneAt', {
            ...who,
            read: integer(prefillStat(tuned.point).median),
            write: f.number(tuned.point.decodeTps.median, 1),
            ctx: tokensK(tuned.combo.maxContext, f),
            depth: tokensK(tuned.point.promptTokens, f),
          })
        : undefined;

  return scrub({
    title: service ? t('sheet.titleNamed', { service, model }) : t('sheet.title', { model }),
    meta: [engineLabelOf(run.engine), run.hardware.gpus[0] ? shortGpuName(run.hardware.gpus[0].name) : '–', t('sheet.measuredOn', { date: dateTime(run.createdAt) })],
    ...(sentence ? { sentence } : {}),
    sections,
    footer: t('sheet.footer', { date: dateTime(input.now.toISOString()), version: input.appVersion }),
  });
}

/** The sheet as a file to save. */
export function sheetRequest(input: SheetInput, format: SheetFormat, f: Formatters): SaveRequest {
  const report = sheetOf(input, f);
  const labels = { powershell: f.t('codeblock.powershell'), bash: f.t('codeblock.bash') };
  const name = `llmbench_${f.t('sheet.fileWord')}_${slug(input.service || input.run.model.displayName)}_${input.now.toISOString().slice(0, 10)}`;
  return format === 'markdown'
    ? { defaultName: `${name}.md`, content: reportToMarkdown(report, labels), mime: 'text/markdown;charset=utf-8', filters: [{ name: 'Markdown', extensions: ['md'] }] }
    : { defaultName: `${name}.html`, content: reportToHtml(report, { lang: f.lang, labels }), mime: 'text/html;charset=utf-8', filters: [{ name: 'HTML', extensions: ['html'] }] };
}
