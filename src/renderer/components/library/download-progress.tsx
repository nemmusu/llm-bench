import type { DownloadJob } from '../../../contract/models';
import { useI18n } from '../../i18n';
import { Progress } from '../ui/progress';

/** Bar + "1,2 GB di 4,7 GB · 86 MB/s · mancano 41 s" for one download. */
export function DownloadProgressLine({ job }: { job: DownloadJob }) {
  const { t, bytes, duration, percent } = useI18n();
  const total = job.bytesTotal ?? 0;
  const ratio = total > 0 ? Math.min(1, job.bytesDone / total) : 0;
  const running = job.state === 'running';
  return (
    <div className="flex flex-col gap-1.5">
      <Progress value={ratio * 100} label={job.label} valueText={percent(ratio)} tone={job.state === 'failed' ? 'danger' : job.state === 'paused' ? 'warning' : 'accent'} size="sm" />
      <div className="flex justify-between gap-3 text-xs text-fg-3 tabular-nums">
        <span>
          {t('downloads.progress', { done: bytes(job.bytesDone), total: bytes(total) })}
          {running && job.bytesPerSec ? ` · ${t('models.speed', { speed: bytes(job.bytesPerSec) })}` : ''}
        </span>
        {running && job.etaSec !== undefined && <span>{t('models.remaining', { time: duration(job.etaSec * 1000) })}</span>}
        {job.state === 'verifying' && <span>{t('downloads.verifying')}</span>}
      </div>
    </div>
  );
}
