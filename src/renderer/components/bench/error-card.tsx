import { useNavigate } from '@tanstack/react-router';
import { CircleAlert } from 'lucide-react';
import type { ReactNode } from 'react';
import type { AppErrorData, ErrorCode } from '../../../contract/errors';
import { useI18n } from '../../i18n';
import { cn } from '../../lib/cn';
import { Button } from '../ui/button';

/** The "cosa fare" button each error code leads to. */
export type FixKind = 'engines' | 'models' | 'pickModel' | 'settings' | 'system' | 'continueAnyway' | 'openLog' | 'results' | 'activeRun' | 'retry';

const FIX: Partial<Record<ErrorCode, FixKind>> = {
  ENGINE_NOT_INSTALLED: 'engines',
  ENGINE_INSTALL_FAILED: 'engines',
  ENGINE_NO_KERNEL_IMAGE: 'engines',
  DOCKER_NOT_INSTALLED: 'engines',
  DOCKER_NOT_RUNNING: 'engines',
  DOCKER_NO_GPU: 'engines',
  DOCKER_PERMISSION: 'engines',
  DOCKER_UNSUPPORTED: 'engines',
  DOCKER_PULL_FAILED: 'engines',
  DOCKER_INSTALL_FAILED: 'engines',
  ENGINE_OOM: 'pickModel',
  MODEL_TOO_LARGE: 'pickModel',
  MODEL_NOT_FOUND: 'models',
  MODEL_INVALID: 'models',
  DOWNLOAD_CHECKSUM: 'models',
  HF_AUTH_REQUIRED: 'settings',
  HF_GATED: 'models',
  DISK_FULL: 'settings',
  GPU_NOT_FOUND: 'system',
  DRIVER_MISSING: 'system',
  DRIVER_TOO_OLD: 'system',
  VRAM_BUSY: 'continueAnyway',
  ENGINE_START_FAILED: 'openLog',
  ENGINE_EXITED: 'openLog',
  ENGINE_BAD_FLAG: 'openLog',
  RUN_NOT_FOUND: 'results',
  RUN_IN_PROGRESS: 'activeRun',
};

/** The fix for a code; "retry" for transient or unknown problems. */
export function fixFor(code: ErrorCode): FixKind {
  return FIX[code] ?? 'retry';
}

export interface ErrorCardProps {
  error: AppErrorData;
  /** Handlers for the fixes that need the screen's context (retry, continue anyway, open the log…). */
  handlers?: Partial<Record<FixKind, () => void>>;
  /** Extra buttons after the fix. */
  extra?: ReactNode;
  className?: string;
  headingLevel?: 2 | 3;
}

/** A failure explained: what happened, what to do, one button that does it, technical details folded. */
export function ErrorCard({ error, handlers = {}, extra, className, headingLevel = 2 }: ErrorCardProps) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const kind = fixFor(error.code);
  const routes: Partial<Record<FixKind, () => void>> = {
    engines: () => void navigate({ to: '/engines' }),
    models: () => void navigate({ to: '/models' }),
    pickModel: () => void navigate({ to: '/' }),
    settings: () => void navigate({ to: '/settings' }),
    system: () => void navigate({ to: '/welcome' }),
    results: () => void navigate({ to: '/results' }),
    ...(typeof error.params?.runId === 'string' ? { activeRun: () => void navigate({ to: '/run/$runId', params: { runId: String(error.params!.runId) } }) } : {}),
  };
  const onFix = handlers[kind] ?? routes[kind];
  const Heading = headingLevel === 2 ? 'h2' : 'h3';
  return (
    <section role="alert" className={cn('rounded-xl border border-danger/30 bg-danger-soft p-5', className)}>
      <div className="flex items-start gap-3">
        <CircleAlert aria-hidden className="mt-0.5 size-5 shrink-0 text-danger-text" />
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <Heading className="text-md font-semibold text-fg">{t(`errors.${error.code}.title`)}</Heading>
          <p className="text-sm text-fg-2">
            <span className="font-medium text-fg">{t('fixes.whatToDo')}</span> {t(`errors.${error.code}.what`)}
          </p>
          {(onFix || extra) && (
            <div className="flex flex-wrap gap-2 pt-1">
              {onFix && (
                <Button size="sm" variant="primary" onClick={onFix}>
                  {t(`fixes.${kind}`)}
                </Button>
              )}
              {extra}
            </div>
          )}
          {error.message && (
            <details className="text-xs text-fg-3">
              <summary className="cursor-pointer rounded-xs select-none hover:text-fg focus-ring">{t('fixes.technical')}</summary>
              <p className="mt-1 font-mono break-all">
                {error.code}: {error.message}
                {error.detail ? ` — ${error.detail}` : ''}
              </p>
            </details>
          )}
        </div>
      </div>
    </section>
  );
}
