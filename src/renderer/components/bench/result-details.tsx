import { useMemo, type ReactNode } from 'react';
import type { LatencyPoint, RunResult, Stat } from '../../../contract/results';
import { useI18n } from '../../i18n';
import { Card, CardHeader, CardTitle } from '../ui/card';
import { columnHelper, DataTable } from '../ui/data-table';
import { MIB_PER_GB } from './format';

export function SimpleTable({ caption, head, rows, numericFrom = 1 }: { caption: string; head: string[]; rows: ReactNode[][]; numericFrom?: number }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-separate border-spacing-0 text-sm">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr>
            {head.map((h, i) => (
              <th key={h} scope="col" className={`h-9 border-b border-border px-3 text-xs font-medium whitespace-nowrap text-fg-3 first:pl-card last:pr-card ${i >= numericFrom ? 'text-right' : 'text-left'}`}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, k) => (
            <tr key={k}>
              {r.map((c, i) =>
                i === 0 ? (
                  <th key={i} scope="row" className="h-row border-b border-border px-3 pl-card text-left font-medium whitespace-nowrap text-fg">
                    {c}
                  </th>
                ) : (
                  <td key={i} className={`h-row border-b border-border px-3 last:pr-card ${i >= numericFrom ? 'text-right tabular-nums' : ''}`}>
                    {c}
                  </td>
                ),
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Card className="overflow-hidden">
      <CardHeader className="pb-3">
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      {children}
    </Card>
  );
}

const latencyCol = columnHelper<LatencyPoint>();

/** Every number of the run, in tables (all statistics). */
export function Details({ run }: { run: RunResult }) {
  const { t, number, integer, percent, bytes, duration } = useI18n();
  const m = run.metrics;
  const dash = '–';
  const columns = useMemo(
    () => [
      latencyCol.accessor('promptTokens', { header: t('result.details.prompt'), cell: (c) => integer(c.getValue()), meta: { numeric: true } }),
      latencyCol.accessor('outputTokens', { header: t('result.details.output'), cell: (c) => integer(c.getValue()), meta: { numeric: true } }),
      latencyCol.accessor((p) => p.ttftMs.median, { id: 'ttft', header: `${t('metrics.ttft.label')} (ms)`, cell: (c) => integer(c.getValue()), meta: { numeric: true } }),
      latencyCol.accessor((p) => p.prefillTps.median, { id: 'prefill', header: `${t('metrics.prefill.label')} (tok/s)`, cell: (c) => integer(c.getValue()), meta: { numeric: true } }),
      latencyCol.accessor((p) => p.prefillTpsEngine?.median, {
        id: 'prefillEngine',
        header: t('result.details.prefillEngine'),
        sortUndefined: 'last',
        cell: (c) => {
          const v = c.getValue();
          return v === undefined ? dash : integer(v);
        },
        meta: { numeric: true },
      }),
      latencyCol.accessor((p) => p.decodeTps.median, { id: 'decode', header: `${t('metrics.decode.label')} (tok/s)`, cell: (c) => number(c.getValue(), 1), meta: { numeric: true } }),
      latencyCol.accessor((p) => p.decodeTpsEngine?.median, {
        id: 'decodeEngine',
        header: t('result.details.decodeEngine'),
        sortUndefined: 'last',
        cell: (c) => {
          const v = c.getValue();
          return v === undefined ? dash : number(v, 1);
        },
        meta: { numeric: true },
      }),
      latencyCol.accessor((p) => p.decodeTps.min, { id: 'min', header: t('result.details.min'), cell: (c) => number(c.getValue(), 1), meta: { numeric: true } }),
      latencyCol.accessor((p) => p.decodeTps.max, { id: 'max', header: t('result.details.max'), cell: (c) => number(c.getValue(), 1), meta: { numeric: true } }),
      latencyCol.accessor((p) => p.decodeTps.cv, { id: 'cv', header: t('result.details.cv'), cell: (c) => percent(c.getValue(), 1), meta: { numeric: true } }),
      latencyCol.accessor((p) => p.decodeTps.n, { id: 'n', header: t('result.details.n'), cell: (c) => c.getValue(), meta: { numeric: true } }),
      latencyCol.accessor('itlP50Ms', { header: `${t('result.details.itlP50')} (ms)`, cell: (c) => number(c.getValue(), 2), meta: { numeric: true } }),
      latencyCol.accessor('itlP95Ms', {
        header: `${t('result.details.itlP95')} (ms)`,
        cell: (c) => `${number(c.getValue(), 2)}${c.row.original.itlPerChunk ? ' *' : ''}`,
        meta: { numeric: true },
      }),
    ],
    [t, number, integer, percent],
  );
  const loadRow = (label: string, s: Stat | undefined) => [
    label,
    s ? number(s.median / 1000, 2) : dash,
    s ? number(s.min / 1000, 2) : dash,
    s ? number(s.max / 1000, 2) : dash,
    s ? percent(s.cv, 1) : dash,
    s ? s.n : dash,
  ];
  const mib = (v: number | undefined) => (v === undefined ? dash : `${number(v / MIB_PER_GB, 2)} GB`);
  const hw = run.hardware;
  const gpu = hw.gpus[0];
  const chunkNote = m.latency.some((p) => p.itlPerChunk);
  return (
    <div className="flex flex-col gap-section">
      <Section title={t('result.details.latency')}>
        {m.latency.length ? (
          <>
            <DataTable caption={t('result.details.latency')} columns={columns} data={m.latency} initialSorting={[{ id: 'promptTokens', desc: false }]} />
            {chunkNote && <p className="px-card py-2 text-xs text-fg-3">{t('result.details.perChunk')}</p>}
          </>
        ) : (
          <p className="px-card pb-card text-sm text-fg-3">{t('result.details.none')}</p>
        )}
      </Section>
      <div className="grid gap-section lg:grid-cols-2">
        <Section title={t('result.details.load')}>
          <SimpleTable
            caption={t('result.details.load')}
            head={[t('result.details.measure'), `${t('result.details.median')} (s)`, t('result.details.min'), t('result.details.max'), t('result.details.cv'), t('result.details.n')]}
            rows={[
              loadRow(t('result.details.cold'), m.load.coldMs),
              loadRow(t('result.details.warm'), m.load.warmMs),
              ...(m.load.containerOverheadMs ? [loadRow(t('result.details.container'), m.load.containerOverheadMs)] : []),
            ]}
          />
          <dl className="grid grid-cols-2 gap-3 px-card py-3 text-sm">
            <div>
              <dt className="text-xs text-fg-3">{t('result.details.diskRead')}</dt>
              <dd className="font-medium tabular-nums">{m.load.coldReadBytesPerSec === undefined ? dash : `${bytes(m.load.coldReadBytesPerSec)}/s`}</dd>
            </div>
            <div>
              <dt className="text-xs text-fg-3">{t('result.details.firstToken')}</dt>
              <dd className="font-medium tabular-nums">{m.firstTokenAfterLoadMs === undefined ? dash : duration(m.firstTokenAfterLoadMs)}</dd>
            </div>
          </dl>
          {m.load.phases.length > 0 && (
            <SimpleTable
              caption={t('result.details.loadPhases')}
              head={[t('result.details.loadPhases'), t('result.details.start'), t('result.details.durationShort')]}
              rows={m.load.phases.map((p) => [p.name, duration(p.startMs), duration(p.endMs - p.startMs)])}
            />
          )}
        </Section>
        <Section title={t('result.details.vram')}>
          <SimpleTable
            caption={t('result.details.vram')}
            head={[t('result.details.measure'), t('result.details.value')]}
            rows={[
              [t('result.details.vramProcess'), mib(m.vram.processPeakMiB)],
              [t('result.details.vramDelta'), mib(m.vram.deltaMiB)],
              [t('result.details.vramPeakTotal'), mib(m.vram.peakMiB)],
              [t('result.details.vramBaseline'), mib(m.vram.baselineMiB)],
              [t('result.details.vramEstimate'), mib(m.vram.estimateMiB)],
              [t('result.details.vramMethod'), m.vram.method ? t(`result.details.method.${m.vram.method}`) : dash],
            ]}
          />
        </Section>
      </div>
      {m.concurrency.length > 0 && (
        <Section title={t('result.details.concurrency')}>
          <SimpleTable
            caption={t('result.details.concurrency')}
            head={[
              t('result.users'),
              t('result.details.requests'),
              `${t('result.aggregate')} (tok/s)`,
              `${t('result.perUser')} (tok/s)`,
              `${t('result.details.ttftP50')} (ms)`,
              `${t('result.details.ttftP95')} (ms)`,
              t('result.details.errors'),
            ]}
            rows={m.concurrency.map((c) => [c.level, c.requests, integer(c.aggregateTps), number(c.perRequestDecodeTpsP50, 1), integer(c.ttftP50Ms), integer(c.ttftP95Ms), c.errors])}
          />
        </Section>
      )}
      <div className="grid gap-section lg:grid-cols-2">
        {m.llamaBench.length > 0 && (
          <Section title={t('result.details.llamaBench')}>
            <SimpleTable
              caption={t('result.details.llamaBench')}
              head={[t('result.details.test'), 'tok/s', '±']}
              rows={m.llamaBench.map((b) => [b.test, number(b.tps, 1), number(b.stddev, 1)])}
            />
          </Section>
        )}
        <Section title={t('result.details.energy')}>
          <SimpleTable
            caption={t('result.details.energy')}
            head={[t('result.details.measure'), t('result.details.value')]}
            rows={[
              [t('metrics.avgPower.label'), m.energy.avgPowerW === undefined ? dash : `${integer(m.energy.avgPowerW)} W`],
              [t('result.details.maxPower'), m.energy.maxPowerW === undefined ? dash : `${integer(m.energy.maxPowerW)} W`],
              [t('metrics.efficiency.label'), m.energy.tokensPerJoule === undefined ? dash : `${number(m.energy.tokensPerJoule, 2)} tok/J`],
              [t('result.details.maxTemp'), m.thermals.maxTempC === undefined ? dash : `${integer(m.thermals.maxTempC)} °C`],
              [t('result.details.throttle'), m.thermals.throttleReasons.length ? m.thermals.throttleReasons.join(', ') : t('common.none')],
            ]}
          />
        </Section>
        <Section title={t('result.details.system')}>
          <SimpleTable
            caption={t('result.details.system')}
            head={[t('result.details.measure'), t('result.details.value')]}
            numericFrom={99}
            rows={[
              [t('result.details.gpu'), gpu ? `${gpu.name} · ${integer(gpu.memoryTotalMiB / MIB_PER_GB)} GB` : dash],
              [t('result.details.driver'), gpu?.driverVersion ?? dash],
              [t('result.details.cuda'), gpu?.cudaVersion ?? dash],
              [t('result.details.cpu'), `${hw.cpu.model} · ${hw.cpu.cores}C/${hw.cpu.threads}T`],
              [t('result.details.ram'), bytes(hw.ramBytes)],
              [t('result.details.os'), hw.os.name],
              [t('result.details.powerPlan'), hw.os.powerPlan ?? dash],
              [t('result.details.host'), hw.hostLabel],
              [t('result.details.app'), `GPU Bench ${run.app.version}`],
            ]}
          />
        </Section>
      </div>
    </div>
  );
}
