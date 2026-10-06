/**
 * A run as a format-neutral document (title, facts, tables, callouts, command), already localized
 * and formatted. Markdown and HTML exports render the same model, so they always say the same.
 */
import type { RunResult, Stat } from '../../../contract/results';
import { engineLabelOf, modelLabelOf, MIB_PER_GB, prefillStat, shortGpuName } from '../../components/bench/format';
import { kpisOf, sentenceKey } from '../../components/bench/kpis';
import { noteText } from '../../components/bench/notes';
import { launchSummaryParts } from '../../components/bench/summary';
import { validityBody } from '../../components/bench/validity';
import type { Formatters } from '../../i18n';

export interface ReportTable {
  head: string[];
  rows: string[][];
  /** Columns from this index on are numeric (right-aligned). */
  numericFrom: number;
}

export interface ReportCallout {
  title: string;
  body: string;
}

export interface ReportSection {
  title: string;
  text?: string;
  table?: ReportTable;
  callouts?: ReportCallout[];
  code?: { powershell: string; bash: string };
}

export interface Report {
  title: string;
  meta: string[];
  sentence?: string;
  sections: ReportSection[];
  footer: string;
}

const DASH = '–';

export function reportOf(run: RunResult, f: Formatters): Report {
  const { t, number, integer, percent, duration, dateTime, bytes } = f;
  const k = kpisOf(run);
  const m = run.metrics;
  const gpu = run.hardware.gpus[0];
  const med = (s: Stat | undefined, digits: number) => (s ? number(s.median, digits) : DASH);
  const gb = (mib: number) => `${number(mib / MIB_PER_GB, 1)} GB`;
  const sections: ReportSection[] = [];

  if (run.error) {
    sections.push({
      title: t(`result.status.${run.status}`),
      callouts: [{ title: t(`errors.${run.error.code}.title`), body: `${t(`errors.${run.error.code}.what`)} (${run.error.message})` }],
    });
  }

  sections.push({
    title: t('result.kpis'),
    table: {
      head: [t('result.details.measure'), t('result.details.value')],
      numericFrom: 1,
      rows: [
        [`${t('metrics.decode.label')} (tok/s)`, med(k.decode, 1)],
        [`${t('metrics.prefill.label')} (tok/s)`, med(k.prefill, 0)],
        [`${t('metrics.ttft.label')} (ms)`, med(k.ttft, 0)],
        [`${t('metrics.coldLoad.label')} (s)`, k.coldMs ? number(k.coldMs.median / 1000, 2) : DASH],
        [`${t('metrics.warmLoad.label')} (s)`, k.warmMs ? number(k.warmMs.median / 1000, 2) : DASH],
        [t('metrics.vramPeak.label'), k.vram ? `${gb(k.vram.mib)}${k.vram.approximate ? ` (${t('result.vramApprox')})` : ''}` : DASH],
        [`${t('metrics.concurrency.label')} (tok/s)`, k.concurrency ? `${integer(k.concurrency.aggregateTps)} · ${t('units.users', { n: k.concurrency.level })}` : DASH],
        [`${t('metrics.efficiency.label')} (tok/J)`, k.tokensPerJoule === undefined ? DASH : number(k.tokensPerJoule, 2)],
        [t('metrics.score.label'), k.score === undefined ? DASH : integer(k.score)],
      ],
    },
  });

  if (m.latency.length) {
    sections.push({
      title: t('result.details.latency'),
      table: {
        head: [
          t('result.details.prompt'),
          `${t('metrics.ttft.label')} (ms)`,
          `${t('metrics.prefill.label')} (tok/s)`,
          `${t('metrics.decode.label')} (tok/s)`,
          t('result.details.cv'),
          `${t('result.details.itlP95')} (ms)`,
        ],
        numericFrom: 0,
        rows: m.latency.map((p) => [
          integer(p.promptTokens),
          integer(p.ttftMs.median),
          integer(prefillStat(p).median),
          number(p.decodeTps.median, 1),
          percent(p.decodeTps.cv, 1),
          number(p.itlP95Ms, 2),
        ]),
      },
    });
  }

  if (m.concurrency.length) {
    sections.push({
      title: t('result.details.concurrency'),
      table: {
        head: [t('result.users'), `${t('result.aggregate')} (tok/s)`, `${t('result.perUser')} (tok/s)`, `${t('result.details.ttftP95')} (ms)`, t('result.details.errors')],
        numericFrom: 0,
        rows: m.concurrency.map((c) => [String(c.level), integer(c.aggregateTps), number(c.perRequestDecodeTpsP50, 1), integer(c.ttftP95Ms), String(c.errors)]),
      },
    });
  }

  const callouts: ReportCallout[] = [
    ...run.validity.map((flag) => ({ title: t(`validity.${flag}.title`), body: validityBody(run, flag, f) })),
    ...run.notes.map((n) => {
      const x = noteText(n, f);
      return { title: x.title, body: x.body };
    }),
  ];
  if (callouts.length) sections.push({ title: t('result.validityTitle'), callouts });

  sections.push({
    title: t('result.tabs.launch'),
    text: launchSummaryParts(run, f).join(' · '),
    code: run.launch.display,
  });

  sections.push({
    title: t('result.details.system'),
    table: {
      head: [t('result.details.measure'), t('result.details.value')],
      numericFrom: 99,
      rows: [
        [t('result.details.gpu'), gpu ? `${gpu.name} · ${integer(gpu.memoryTotalMiB / MIB_PER_GB)} GB` : DASH],
        [t('result.details.driver'), gpu?.driverVersion ?? DASH],
        [t('result.details.cuda'), gpu?.cudaVersion ?? DASH],
        [t('result.details.cpu'), `${run.hardware.cpu.model} · ${run.hardware.cpu.cores}C/${run.hardware.cpu.threads}T`],
        [t('result.details.ram'), bytes(run.hardware.ramBytes)],
        [t('result.details.os'), run.hardware.os.name],
        [t('result.details.host'), run.hardware.hostLabel],
        [t('result.details.duration'), duration(Math.max(0, Date.parse(run.finishedAt) - Date.parse(run.createdAt)))],
      ],
    },
  });

  return {
    title: `${modelLabelOf(run.model)} · ${engineLabelOf(run.engine)}`,
    meta: [
      gpu ? shortGpuName(gpu.name) : DASH,
      dateTime(run.createdAt),
      t(`benchmark.profiles.${run.scenario.profile}`),
      t(`result.status.${run.status}`),
    ],
    ...(k.wordsPerSec === undefined ? {} : { sentence: t(sentenceKey(k.wordsPerSec), { words: integer(k.wordsPerSec) }) }),
    sections,
    footer: t('export.footer', { version: run.app.version, id: run.id }),
  };
}
