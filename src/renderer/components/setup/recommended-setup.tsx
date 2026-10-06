import { Download, Gauge, Server, Timer } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import type { LocalModel } from '../../../contract/models';
import type { CuratedResponse } from '../../../contract/views';
import { useI18n } from '../../i18n';
import { useCurated, useDownloadJobs, useEngineStatuses, useLibraryModels, useSystemCheck } from '../../lib/queries-library';
import { DownloadDialog, type DownloadChoice } from '../library/download-dialog';
import { DownloadProgressLine } from '../library/download-progress';
import { ErrorCallout } from '../library/error-callout';
import { curatedWeakKey, fileName } from '../library/helpers';
import { FitFor, TriedFor } from '../library/model-badges';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Skeleton } from '../ui/skeleton';
import { LlamaInstall } from './llama-install';

function SetupRow({ icon, label, value, why, extra }: { icon: ReactNode; label: string; value: ReactNode; why: string; extra?: ReactNode }) {
  return (
    <li className="flex items-start gap-4 py-4 first:pt-1 last:pb-1">
      <span aria-hidden className="grid size-10 shrink-0 place-items-center rounded-lg bg-accent-soft text-accent-text [&_svg]:size-5">
        {icon}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <p className="text-xs font-medium text-fg-3">{label}</p>
        <div className="text-md font-semibold text-fg">{value}</div>
        <p className="text-sm text-fg-2">{why}</p>
        {extra && <div className="mt-1 flex flex-wrap items-center gap-1.5">{extra}</div>}
      </div>
    </li>
  );
}

export type Reference = CuratedResponse['reference'];

/** What the wizard proposes: a model already on the PC, else the small reference model (it also earns a score). */
export function useRecommendation(): { local?: LocalModel; reference?: Reference; pending: boolean; error: unknown } {
  const local = useLibraryModels();
  const curated = useCurated();
  const model = local.data?.[0];
  if (model) return { local: model, pending: false, error: null };
  return {
    ...(curated.data ? { reference: curated.data.reference } : {}),
    pending: local.isPending || curated.isPending,
    error: local.error ?? curated.error,
  };
}

/** The download of the recommended reference model, if one was started (and not cancelled). */
export function useReferenceJob() {
  const rec = useRecommendation();
  const jobs = useDownloadJobs();
  const ref = rec.reference;
  return ref ? jobs.data?.find((j) => j.repo === ref.repo && j.files.some((f) => fileName(f.path) === ref.file) && j.state !== 'cancelled') : undefined;
}

/** Step 2 of the wizard: engine, model and duration, each with why it was chosen. */
export function RecommendedSetup({ gpuName }: { gpuName: string }) {
  const { t, bytes } = useI18n();
  const engines = useEngineStatuses();
  const check = useSystemCheck();
  const rec = useRecommendation();
  const job = useReferenceJob();
  const [choice, setChoice] = useState<DownloadChoice>();
  const llama = engines.data?.find((e) => e.kind === 'llamacpp-native');
  const llamaBytes = check.data?.items.find((i) => i.id === 'llamacpp')?.action?.bytes;
  const ref = rec.reference;

  let model: ReactNode;
  if (rec.local) {
    const m = rec.local;
    model = (
      <SetupRow
        icon={<Gauge />}
        label={t('welcome.setup.modelLabel')}
        value={`${m.identity.displayName}${m.identity.quant ? ` · ${m.identity.quant}` : ''} · ${bytes(m.identity.sizeBytes ?? 0)}`}
        why={t('welcome.setup.modelLocalWhy')}
        extra={
          <>
            <Badge tone="success" size="sm">
              {t('welcome.setup.onPc')}
            </Badge>
            <FitFor req={{ localId: m.id, engine: 'llamacpp-native' }} />
            <TriedFor weakKey={m.identity.weakKey} sha256={m.identity.sha256} />
          </>
        }
      />
    );
  } else if (ref) {
    model = (
      <SetupRow
        icon={<Gauge />}
        label={t('welcome.setup.modelLabel')}
        value={`${ref.label} · ${bytes(ref.sizeBytes)}`}
        why={t('welcome.setup.modelWhy')}
        extra={
          <div className="flex w-full flex-col gap-2">
            <div className="flex flex-wrap items-center gap-1.5">
              <FitFor req={{ repo: ref.repo, file: ref.file, engine: 'llamacpp-native' }} />
              <TriedFor weakKey={curatedWeakKey(ref)} sha256={ref.sha256} />
            </div>
            {job && job.state !== 'done' ? (
              <DownloadProgressLine job={job} />
            ) : (
              <Button
                variant="primary"
                size="sm"
                className="self-start"
                onClick={() =>
                  setChoice({
                    repo: ref.repo,
                    revision: ref.revision,
                    files: [ref.file],
                    label: ref.label,
                    sizeBytes: ref.sizeBytes,
                    weakKey: curatedWeakKey(ref),
                    sha256: ref.sha256,
                  })
                }
              >
                <Download aria-hidden />
                {t('welcome.setup.download', { size: bytes(ref.sizeBytes) })}
              </Button>
            )}
          </div>
        }
      />
    );
  } else if (rec.pending) {
    model = <Skeleton className="my-4 h-16" />;
  } else {
    model = <ErrorCallout error={rec.error} className="my-4" />;
  }

  return (
    <section aria-labelledby="welcome-setup" className="flex flex-col px-7 pt-6 pb-4">
      <h2 id="welcome-setup" className="text-xl font-semibold tracking-[-0.015em]">
        {t('welcome.setup.title')}
      </h2>
      <p className="mt-1 text-sm text-fg-2">{t('welcome.setup.intro', { gpu: gpuName })}</p>
      <ul className="mt-4 divide-y divide-border">
        <SetupRow
          icon={<Server />}
          label={t('welcome.setup.engineLabel')}
          value={llama?.installed && llama.available ? `llama.cpp ${llama.version ?? ''}`.trim() : 'llama.cpp'}
          why={t('welcome.setup.engineWhy')}
          extra={
            llama?.installed && llama.available ? (
              <Badge tone="success" size="sm">
                {t('common.installed')}
              </Badge>
            ) : (
              <LlamaInstall bytes={llamaBytes} />
            )
          }
        />
        {model}
        <SetupRow
          icon={<Timer />}
          label={t('welcome.setup.durationLabel')}
          value={t('welcome.setup.quick')}
          why={t('welcome.setup.durationWhy')}
        />
      </ul>
      <DownloadDialog choice={choice} onOpenChange={(o) => !o && setChoice(undefined)} />
    </section>
  );
}
