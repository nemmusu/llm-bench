/** Validity flags of a run in plain words (shared by the result page and the exports). */
import type { RunResult, ValidityFlag } from '../../../contract/results';
import type { Formatters } from '../../i18n';
import { MIB_PER_GB } from './format';

/** "llama-server.exe (PID 4242, 2,3 GB), vmmem (PID 77)". */
export function sharedGpuList(run: Pick<RunResult, 'sharedGpu'>, f: Pick<Formatters, 't' | 'number'>): string {
  return run.sharedGpu
    .map((u) =>
      u.memMiB === undefined
        ? f.t('validity.gpu_shared.process', { name: u.name, pid: u.pid })
        : f.t('validity.gpu_shared.processMem', { name: u.name, pid: u.pid, size: `${f.number(u.memMiB / MIB_PER_GB, 1)} GB` }),
    )
    .join(', ');
}

export function validityBody(run: Pick<RunResult, 'sharedGpu'>, flag: ValidityFlag, f: Pick<Formatters, 't' | 'number'>): string {
  if (flag === 'gpu_shared' && run.sharedGpu.length) return f.t('validity.gpu_shared.bodyList', { list: sharedGpuList(run, f) });
  return f.t(`validity.${flag}.body`);
}
