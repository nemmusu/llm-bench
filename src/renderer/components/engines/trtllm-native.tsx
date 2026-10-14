/**
 * TensorRT-LLM installed with uv/pip in LLM Bench's own environment (on Linux, inside WSL on Windows):
 * what WSL lacks first (its command to copy, then "Ricontrolla"), then the install with its progress;
 * once there, its version "Sul PC", "In uso" or "Usa questo", the update, and the removal after a confirmation.
 */
import { Check, CircleX, Download, HardDrive, RefreshCw, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import type { EngineStatus } from '../../../contract/engines';
import { useI18n } from '../../i18n';
import { activeEvent, useInstallEvent, useRecheck, useSaveEngine, useStartInstall } from '../../lib/queries-library';
import { useRemoveTrtllmNative } from '../../lib/queries-trtllm';
import { useSettings } from '../../lib/settings';
import { ErrorCallout } from '../library/error-callout';
import { InstallProgress } from '../setup/install-progress';
import { Badge } from '../ui/badge';
import { Button, IconButton } from '../ui/button';
import { CodeBlock } from '../ui/code-block';
import { ConfirmDialog } from '../ui/dialog';
import { EngineUpdatePanel } from './engine-update';
import { nativeNeed } from './trtllm-format';

/** The 'engine.install' kind of the native install's progress. */
export const TRTLLM_NATIVE_INSTALL = 'trtllm-native';

/** The distro WSL installs when it has none. */
const DISTRO = 'Ubuntu-24.04';

/** "Ricontrolla": the system check and every engine status read again. */
function Recheck() {
  const { t } = useI18n();
  const recheck = useRecheck();
  return (
    <>
      <Button variant="primary" size="sm" className="self-start" disabled={recheck.isPending} onClick={() => recheck.mutate()}>
        <RefreshCw aria-hidden />
        {recheck.isPending ? t('trtllm.native.checking') : t('trtllm.native.recheck')}
      </Button>
      {recheck.isError && <ErrorCallout error={recheck.error} />}
    </>
  );
}

/** What WSL lacks before LLM Bench can install: WSL itself, or a Linux distro in it; its command in PowerShell. */
function Need({ need }: { need: 'wsl' | 'distro' }) {
  const { t } = useI18n();
  const command = need === 'wsl' ? 'wsl --install' : `wsl --install -d ${DISTRO}`;
  const name = t(`trtllm.native.needs.${need}`);
  return (
    <section className="flex flex-col gap-3 rounded-lg border border-warning/40 bg-warning-soft/30 p-3" aria-label={t('trtllm.native.needsTitle')}>
      <div className="flex flex-col gap-0.5">
        <h3 className="text-sm font-semibold text-fg">{t('trtllm.native.needsTitle')}</h3>
        <p className="flex items-center gap-2 text-sm">
          <CircleX aria-hidden className="size-4 shrink-0 text-danger-text" />
          <span className="font-medium text-fg">{name}</span>
          <span className="text-danger-text">{t('trtllm.native.missing')}</span>
        </p>
        <p className="text-sm text-fg-2">{t(need === 'wsl' ? 'trtllm.native.needWsl' : 'trtllm.native.needDistro')}</p>
      </div>
      <CodeBlock single label={t('trtllm.native.command', { need: name })} commands={{ powershell: command, bash: command }} defaultShell="powershell" />
      <Recheck />
    </section>
  );
}

/** The native way: what WSL lacks, the install, the version on the PC. */
export function TrtllmNative({ status, wsl }: { status: EngineStatus | undefined; wsl: boolean }) {
  const { t } = useI18n();
  const { settings } = useSettings();
  const save = useSaveEngine();
  const start = useStartInstall();
  const remove = useRemoveTrtllmNative();
  const event = useInstallEvent(TRTLLM_NATIVE_INSTALL);
  const [confirm, setConfirm] = useState(false);
  if (!status || status.supported === false) return <p className="text-sm text-fg-2">{t('trtllm.native.unsupported')}</p>;
  const running = activeEvent(event);
  const need = nativeNeed(status);
  const distro = status.variant ?? DISTRO;
  const inUse = settings.lastEngine?.kind === 'trtllm-native' && settings.lastEngine.customEngineId === undefined;
  const version = status.version ?? '';
  const path = status.location ?? '';
  return (
    <div className="flex flex-col gap-3">
      {need && <Need need={need} />}
      {!need && !status.installed &&
        (running ? (
          <InstallProgress event={running} label={t('trtllm.native.progress')} className="w-full" />
        ) : (
          <div className="flex flex-col gap-2 rounded-lg border border-border bg-surface-2 p-3">
            <Button variant="primary" size="sm" className="self-start" disabled={start.isPending} onClick={() => start.mutate({ key: TRTLLM_NATIVE_INSTALL, path: '/api/engines/trtllm-native/install' })}>
              <Download aria-hidden />
              {t('trtllm.native.installAny')}
            </Button>
            <p className="text-xs text-fg-3">{wsl ? t('trtllm.native.installHintWsl', { distro }) : t('trtllm.native.installHint')}</p>
          </div>
        ))}
      {event?.stage === 'error' && <ErrorCallout error={event.error ?? { code: 'ENGINE_INSTALL_FAILED', message: TRTLLM_NATIVE_INSTALL }} />}
      {status.installed && (
        <>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-border px-3 py-2.5">
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-sm font-semibold text-fg">{version || t('trtllm.title')}</span>
                {inUse && (
                  <Badge size="sm" tone="success">
                    <Check aria-hidden />
                    {t('trtllm.inUse')}
                  </Badge>
                )}
                <Badge size="sm" tone="outline">
                  <HardDrive aria-hidden />
                  {t('trtllm.onPcNoSize')}
                </Badge>
              </span>
              {path && (
                <span className="truncate font-mono text-xs text-fg-3" title={path}>
                  {wsl ? `${distro}: ${path}` : path}
                </span>
              )}
            </span>
            <span className="flex items-center gap-1">
              {!inUse && (
                <Button size="sm" onClick={() => save.mutate({ kind: 'trtllm-native' })}>
                  {t('trtllm.native.use')}
                </Button>
              )}
              <IconButton label={t('trtllm.native.remove', { version })} icon={<Trash2 />} size="sm" onClick={() => setConfirm(true)} />
            </span>
          </div>
          {/* On the PC but it does not start: a system library (Open MPI), or another reason, said with its fix. */}
          {!status.available && status.problems[0] && (
            <>
              <ErrorCallout error={{ code: status.problems[0] as never, message: status.problems[0], ...(status.problemParams ? { params: status.problemParams } : {}) }} />
              <Recheck />
            </>
          )}
        </>
      )}
      <EngineUpdatePanel target="trtllm-native" name={t('benchmark.engines.trtllm-native')} enabled={status.available} />
      {save.isError && <ErrorCallout error={save.error} />}
      {remove.isError && <ErrorCallout error={remove.error} />}
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title={t('trtllm.native.removeTitle', { version })}
        description={t('trtllm.native.removeBody', { path })}
        confirmLabel={t('trtllm.native.removeConfirm')}
        cancelLabel={t('common.cancel')}
        onConfirm={() => remove.mutate(undefined, { onSuccess: () => toast.success(t('trtllm.native.removed')) })}
      />
    </div>
  );
}
