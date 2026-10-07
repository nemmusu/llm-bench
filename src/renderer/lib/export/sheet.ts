/**
 * "Scheda da condividere": a well-written page about a server, for the team that uses it. Built from
 * one result (and the one before it, from the Compare page): the model and the configuration in
 * words, the exact command, how fast it reads and writes, what long conversations wait, what the
 * cache saves, how the queue works, how much context the memory holds, the comparison in words and
 * a glossary. Never any secret: commands are stored redacted, and every text is scrubbed again.
 */
import type { RunResult } from '../../../contract/results';
import { metricRows } from '../../components/bench/compare-rows';
import { rowWords } from '../../components/bench/compare-words';
import { engineLabelOf, headlinePoint, MIB_PER_GB, modelLabelOf, prefillStat, shortGpuName, slug } from '../../components/bench/format';
import { launchSummaryParts } from '../../components/bench/summary';
import { kvCapacityText, sessionsGlossary, sessionsOf, sessionsRows, sessionsSentences, sessionsTable, soloPoint } from '../../components/bench/sessions-view';
import type { Formatters } from '../../i18n';
import { reportToHtml } from './html';
import { reportToMarkdown } from './markdown';
import type { Report, ReportSection } from './report';
import type { SaveRequest } from './save';

export interface SheetInput {
  /** The result the sheet is about ("Ora" in a comparison). */
  run: RunResult;
  /** The configuration before ("Prima"), from the Compare page. */
  before?: RunResult;
  /** Typed by the user in the export dialog (all optional). */
  service?: string;
  address?: string;
  notes?: string;
  /** GPU Bench version that writes the sheet. */
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
      ...(s.table ? { table: { ...s.table, head: s.table.head.map(r), rows: s.table.rows.map((row) => row.map(r)) } } : {}),
      ...(s.callouts ? { callouts: s.callouts.map((c) => ({ title: r(c.title), body: r(c.body) })) } : {}),
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

function speedSections(run: RunResult, f: Formatters): ReportSection[] {
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
    const queued = points.filter((p) => p.sessions > 1 && p.firstTurn.queueWaitMs.n > 0).sort((a, b) => a.sessions - b.sessions);
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
  }
  return out;
}

function comparisonSection(before: RunResult, run: RunResult, f: Formatters): ReportSection {
  const { t, dateTime } = f;
  const rows = metricRows(before, run, f).map((r) => {
    const words = rowWords(r, f);
    const cell = (v: number | undefined, reread: boolean | undefined) => (v === undefined ? '–' : reread ? `${t('longConversations.compare.reread')} (${r.format(v)})` : r.format(v));
    return [r.label, cell(r.a, r.reread?.a), cell(r.b, r.reread?.b), words ? (words.direction === 'same' ? t('compare.same') : words.text) : '–'];
  });
  const same = before.hardware.hostId === run.hardware.hostId && before.model.weakKey === run.model.weakKey;
  return {
    title: t('sheet.sections.compare'),
    text: t(same ? 'sheet.compare.sameMachine' : 'sheet.compare.intro', {
      before: `${engineLabelOf(before.engine)}, ${dateTime(before.createdAt)}`,
      now: `${engineLabelOf(run.engine)}, ${dateTime(run.createdAt)}`,
    }),
    table: { head: [t('sheet.compare.metric'), t('longConversations.compare.before'), t('longConversations.compare.now'), t('sheet.compare.difference')], rows, numericFrom: 1 },
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
      ...(notes ? { paragraphs: notes.split(/\r?\n\s*\r?\n/).map((p) => p.replace(/\s*\r?\n\s*/g, ' ')) } : {}),
    });
  }

  const ctx = run.launch.params.contextSize ?? run.launch.params.maxModelLen;
  sections.push({
    title: t('sheet.sections.setup'),
    table: {
      head: [t('sheet.facts.what'), t('sheet.facts.value')],
      numericFrom: 99,
      rows: [
        [t('sheet.facts.model'), [model, modelInWords(run, f)].filter(Boolean).join(' — ')],
        [t('sheet.facts.engine'), engineLabelOf(run.engine) + (run.engine.image ? ` · ${run.engine.image}` : '')],
        [t('sheet.facts.gpu'), m.gpu],
        [t('sheet.facts.pc'), m.pc || '–'],
        [t('sheet.facts.launch'), launchSummaryParts(run, f).slice(2).join(' · ') || t('sheet.facts.defaults')],
        ...(ctx !== undefined ? [[t('sheet.facts.context'), t('sheet.facts.contextValue', { n: integer(ctx) })]] : []),
      ],
    },
    paragraphs: [t('sheet.facts.commandIntro')],
    code: run.launch.display,
  });

  sections.push(...speedSections(run, f));
  if (run.metrics.kvCapacity) {
    sections.push({ title: t('sheet.sections.memory'), text: t('sheet.memory.body', { value: kvCapacityText(run.metrics.kvCapacity, f) }) });
  }
  if (input.before) sections.push(comparisonSection(input.before, run, f));
  if (sessionsOf(run).length) {
    sections.push({ title: t('sheet.sections.glossary'), definitions: sessionsGlossary(f), paragraphs: [t('longConversations.proportional')] });
  }

  const solo = soloPoint(sessionsOf(run));
  const p = headlinePoint(run.metrics.latency);
  const sentence = solo?.aggregatePrefillTps !== undefined
    ? t('sheet.summary.sessions', { model, engine: engineLabelOf(run.engine), gpu: shortGpuName(run.hardware.gpus[0]?.name ?? '–'), read: integer(solo.aggregatePrefillTps), write: f.number(solo.firstTurn.decodeTps.median, 1), depth: integer(solo.depth) })
    : p
      ? t('sheet.summary.basic', { model, engine: engineLabelOf(run.engine), gpu: shortGpuName(run.hardware.gpus[0]?.name ?? '–'), read: integer(prefillStat(p).median), write: f.number(p.decodeTps.median, 1) })
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
  const name = `gpubench_${f.t('sheet.fileWord')}_${slug(input.service || input.run.model.displayName)}_${input.now.toISOString().slice(0, 10)}`;
  return format === 'markdown'
    ? { defaultName: `${name}.md`, content: reportToMarkdown(report, labels), mime: 'text/markdown;charset=utf-8', filters: [{ name: 'Markdown', extensions: ['md'] }] }
    : { defaultName: `${name}.html`, content: reportToHtml(report, { lang: f.lang, labels }), mime: 'text/html;charset=utf-8', filters: [{ name: 'HTML', extensions: ['html'] }] };
}
