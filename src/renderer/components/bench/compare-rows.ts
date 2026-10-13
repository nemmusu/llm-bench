/** The compare page as data: headline numbers side by side, and every setting that differs. */
import type { LaunchParams } from '../../../contract/engines';
import type { RunResult } from '../../../contract/results';
import type { Formatters, MessageKey } from '../../i18n';
import { longConversationRows, type WordsRow } from './compare-words';
import { engineLabelOf, MIB_PER_GB, modelLabelOf, prettyVariant } from './format';
import { kpisOf } from './kpis';

/** A headline number of both runs, and how its difference is worded (speed, amount or time). */
export type MetricRow = WordsRow;

export function metricRows(a: RunResult, b: RunResult, f: Pick<Formatters, 't' | 'number' | 'integer' | 'percent' | 'duration'>): MetricRow[] {
  const { t, number, integer } = f;
  const ka = kpisOf(a);
  const kb = kpisOf(b);
  const tps1 = (v: number) => `${number(v, 1)} tok/s`;
  const tps0 = (v: number) => `${integer(v)} tok/s`;
  const sec = (v: number) => `${number(v / 1000, 2)} s`;
  const rows: MetricRow[] = [
    { id: 'decode', label: t('metrics.decode.label'), a: ka.decode?.median, b: kb.decode?.median, higherIsBetter: true, kind: 'speed', format: tps1 },
    { id: 'prefill', label: t('metrics.prefill.label'), a: ka.prefill?.median, b: kb.prefill?.median, higherIsBetter: true, kind: 'speed', format: tps0 },
    { id: 'ttft', label: t('metrics.ttft.label'), a: ka.ttft?.median, b: kb.ttft?.median, higherIsBetter: false, kind: 'time', format: (v) => `${integer(v)} ms` },
    { id: 'cold', label: t('metrics.coldLoad.label'), a: ka.coldMs?.median, b: kb.coldMs?.median, higherIsBetter: false, kind: 'time', format: sec },
    { id: 'warm', label: t('metrics.warmLoad.label'), a: ka.warmMs?.median, b: kb.warmMs?.median, higherIsBetter: false, kind: 'time', format: sec },
    { id: 'vram', label: t('metrics.vramPeak.label'), a: ka.vram?.mib, b: kb.vram?.mib, higherIsBetter: false, kind: 'amount', format: (v) => `${number(v / MIB_PER_GB, 1)} GB` },
    { id: 'concurrency', label: t('metrics.concurrency.label'), a: ka.concurrency?.aggregateTps, b: kb.concurrency?.aggregateTps, higherIsBetter: true, kind: 'speed', format: tps0 },
    { id: 'efficiency', label: t('metrics.efficiency.label'), a: ka.tokensPerJoule, b: kb.tokensPerJoule, higherIsBetter: true, kind: 'amount', format: (v) => `${number(v, 2)} tok/J` },
    { id: 'score', label: t('metrics.score.label'), a: ka.score, b: kb.score, higherIsBetter: true, kind: 'amount', format: integer },
    // "Conversazioni lunghe" and the KV cache, at the same depth in both runs.
    ...longConversationRows(a, b, f),
  ];
  // A metric neither run measured says nothing.
  return rows.filter((r) => r.a !== undefined || r.b !== undefined);
}

export type DiffGroup = 'engine' | 'model' | 'params' | 'system';

export interface DiffRow {
  group: DiffGroup;
  label: string;
  a: string;
  b: string;
  differs: boolean;
}

const PARAM_LABELS: Record<Exclude<keyof LaunchParams, never>, MessageKey> = {
  contextSize: 'benchmark.expert.ctx',
  gpuLayers: 'benchmark.expert.ngl',
  flashAttention: 'benchmark.expert.flashAttention',
  kvCacheType: 'benchmark.expert.kvCache',
  batchSize: 'benchmark.expert.batch',
  ubatchSize: 'benchmark.expert.ubatch',
  threads: 'benchmark.expert.threads',
  parallel: 'benchmark.expert.parallel',
  gpuMemoryUtilization: 'benchmark.expert.gpuMemory',
  maxModelLen: 'benchmark.expert.maxModelLen',
  dtype: 'benchmark.expert.dtype',
  quantization: 'benchmark.expert.quantization',
  ropeScaling: 'benchmark.expert.ropeScaling',
  extraArgs: 'benchmark.expert.extraArgs',
  env: 'benchmark.expert.env',
};

function paramText(key: keyof LaunchParams, p: LaunchParams, auto: string): string {
  const v = p[key];
  if (key === 'extraArgs') return p.extraArgs.length ? p.extraArgs.join(' ') : auto;
  if (key === 'ropeScaling') return p.ropeScaling ? `${p.ropeScaling.type} ×${p.ropeScaling.factor} (${p.ropeScaling.originalContext})` : auto;
  if (key === 'env') {
    const e = Object.entries(p.env);
    return e.length ? e.map(([k, x]) => `${k}=${x}`).join(' ') : auto;
  }
  return v === undefined ? auto : String(v);
}

export function diffRows(a: RunResult, b: RunResult, f: Pick<Formatters, 't' | 'bytes'>): DiffRow[] {
  const { t } = f;
  const dash = '–';
  const auto = t('common.auto');
  const row = (group: DiffGroup, label: string, x: string, y: string): DiffRow => ({ group, label, a: x, b: y, differs: x !== y });
  const ga = a.hardware.gpus[0];
  const gb = b.hardware.gpus[0];
  const rows: DiffRow[] = [
    row('engine', t('compare.rows.engine'), engineLabelOf(a.engine), engineLabelOf(b.engine)),
    row('engine', t('compare.rows.variant'), a.engine.variant ? prettyVariant(a.engine.variant) : dash, b.engine.variant ? prettyVariant(b.engine.variant) : dash),
    row('engine', t('compare.rows.image'), a.engine.imageDigest ?? a.engine.image ?? dash, b.engine.imageDigest ?? b.engine.image ?? dash),
    row('model', t('compare.rows.model'), modelLabelOf(a.model), modelLabelOf(b.model)),
    row('model', t('compare.rows.quant'), a.model.quant ?? dash, b.model.quant ?? dash),
    row('model', t('compare.rows.size'), a.model.sizeBytes === undefined ? dash : f.bytes(a.model.sizeBytes), b.model.sizeBytes === undefined ? dash : f.bytes(b.model.sizeBytes)),
    row('model', 'sha256', a.model.sha256?.slice(0, 12) ?? dash, b.model.sha256?.slice(0, 12) ?? dash),
    row('params', t('compare.rows.profile'), t(`benchmark.profiles.${a.scenario.profile}`), t(`benchmark.profiles.${b.scenario.profile}`)),
  ];
  for (const key of Object.keys(PARAM_LABELS) as (keyof LaunchParams)[]) {
    const x = paramText(key, a.launch.params, auto);
    const y = paramText(key, b.launch.params, auto);
    // Settings both runs left automatic are noise in a comparison.
    if (x === auto && y === auto) continue;
    rows.push(row('params', t(PARAM_LABELS[key]), x, y));
  }
  rows.push(
    row('system', t('result.details.gpu'), ga?.name ?? dash, gb?.name ?? dash),
    row('system', t('result.details.driver'), ga?.driverVersion ?? dash, gb?.driverVersion ?? dash),
    row('system', t('result.details.cuda'), ga?.cudaVersion ?? dash, gb?.cudaVersion ?? dash),
    row('system', t('result.details.os'), a.hardware.os.name, b.hardware.os.name),
    row('system', t('result.details.host'), a.hardware.hostLabel, b.hardware.hostLabel),
    row('system', t('result.details.app'), a.app.version, b.app.version),
  );
  return rows;
}
