/** "Cosa cambia tra loro": every setting of the compared items side by side, the different ones marked. */
import { trtllmParamsText, type LaunchParams } from '../../../contract/engines';
import { ninferParamsText } from '../../../contract/ninfer';
import { runAppLabel } from '../../../contract/results';
import type { Formatters, MessageKey } from '../../i18n';
import { modelLabelOf, prettyVariant } from '../bench/format';
import { engineName, type CompareItem } from './compare-model';

export type DiffGroup = 'engine' | 'model' | 'params' | 'system';
export const DIFF_GROUPS: readonly DiffGroup[] = ['engine', 'model', 'params', 'system'];

export interface DiffRow {
  group: DiffGroup;
  label: string;
  values: string[];
  /** Not every item has the same value. */
  differs: boolean;
}

const PARAM_LABELS: Record<keyof LaunchParams, MessageKey> = {
  contextSize: 'benchmark.expert.ctx',
  gpuLayers: 'benchmark.expert.ngl',
  vision: 'benchmark.switches.vision.label',
  reasoning: 'benchmark.switches.reasoning.label',
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
  ninfer: 'benchmark.expert.ninfer',
  trtllm: 'benchmark.expert.trtllm',
  extraArgs: 'benchmark.expert.extraArgs',
  env: 'benchmark.expert.env',
};

/** A launch setting as text; unset reads "automatico". */
export function paramText(key: keyof LaunchParams, p: LaunchParams, auto: string): string {
  if (key === 'extraArgs') return p.extraArgs.length ? p.extraArgs.join(' ') : auto;
  if (key === 'ropeScaling') return p.ropeScaling ? `${p.ropeScaling.type} ×${p.ropeScaling.factor} (${p.ropeScaling.originalContext})` : auto;
  if (key === 'ninfer') return ninferParamsText(p.ninfer) || auto;
  if (key === 'trtllm') return trtllmParamsText(p.trtllm) || auto;
  if (key === 'env') {
    const e = Object.entries(p.env);
    return e.length ? e.map(([k, x]) => `${k}=${x}`).join(' ') : auto;
  }
  const v = p[key];
  return v === undefined ? auto : String(v);
}

export function diffRows(items: readonly CompareItem[], f: Pick<Formatters, 't' | 'bytes'>): DiffRow[] {
  const { t } = f;
  const dash = '–';
  const auto = t('common.auto');
  const row = (group: DiffGroup, label: string, pick: (it: CompareItem) => string): DiffRow => {
    const values = items.map(pick);
    return { group, label, values, differs: values.some((v) => v !== values[0]) };
  };
  const gpu = (it: CompareItem) => it.run.hardware.gpus[0];
  const rows: DiffRow[] = [
    row('engine', t('compare.diff.engine'), (it) => engineName(it.run.engine, f)),
    row('engine', t('compare.diff.variant'), (it) => (it.run.engine.variant ? prettyVariant(it.run.engine.variant) : dash)),
    row('engine', t('compare.diff.image'), (it) => it.run.engine.imageDigest ?? it.run.engine.image ?? dash),
    row('model', t('compare.diff.model'), (it) => modelLabelOf(it.run.model)),
    row('model', t('compare.diff.quant'), (it) => it.run.model.quant ?? dash),
    row('model', t('compare.diff.size'), (it) => (it.run.model.sizeBytes === undefined ? dash : f.bytes(it.run.model.sizeBytes))),
    row('model', 'sha256', (it) => it.run.model.sha256?.slice(0, 12) ?? dash),
    row('params', t('compare.diff.profile'), (it) => t(`benchmark.profiles.${it.run.scenario.profile}`)),
  ];
  for (const key of Object.keys(PARAM_LABELS) as (keyof LaunchParams)[]) {
    const r = row('params', t(PARAM_LABELS[key]), (it) => paramText(key, it.params, auto));
    // Settings every item left automatic are noise in a comparison.
    if (r.values.every((v) => v === auto)) continue;
    rows.push(r);
  }
  rows.push(
    row('system', t('result.details.gpu'), (it) => gpu(it)?.name ?? dash),
    row('system', t('result.details.driver'), (it) => gpu(it)?.driverVersion ?? dash),
    row('system', t('result.details.cuda'), (it) => gpu(it)?.cudaVersion ?? dash),
    row('system', t('result.details.os'), (it) => it.run.hardware.os.name),
    row('system', t('result.details.host'), (it) => it.run.hardware.hostLabel),
    row('system', t('result.details.app'), (it) => runAppLabel(it.run.app)),
  );
  return rows;
}
