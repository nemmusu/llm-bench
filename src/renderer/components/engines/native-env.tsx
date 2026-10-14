import { FolderCog, Trash2 } from 'lucide-react';
import { useState } from 'react';
import type { NativeEnvKind } from '../../../contract/native-envs';
import { useI18n } from '../../i18n';
import { useNativeEnv, useRemoveNativeEnv } from '../../lib/queries-native-env';
import { ErrorCallout } from '../library/error-callout';
import { IconButton } from '../ui/button';
import { ConfirmDialog } from '../ui/dialog';

export interface NativeEnvRowProps {
  kind: NativeEnvKind;
  /** The engine's name: "vLLM (Linux)", "SGLang (Linux)". */
  name: string;
}

/**
 * The Python environment LLM Bench installed for vLLM or SGLang on Linux: where it is, how big, and its
 * removal after a confirmation (the folder, its size; results stay). Not while a test, a server or an
 * install uses the engines. A Python environment of the user's own is theirs: said, never removed.
 */
export function NativeEnvRow({ kind, name }: NativeEnvRowProps) {
  const { t, bytes } = useI18n();
  const plan = useNativeEnv(kind);
  const remove = useRemoveNativeEnv(kind);
  const [confirm, setConfirm] = useState(false);
  const p = plan.data;
  if (!p?.supported) return null;
  return (
    <>
      {p.own && <p className="text-xs break-all text-fg-3">{t('engines.native.own', { path: p.own })}</p>}
      {p.installed && (
        <div className="flex items-center gap-2 rounded-lg border border-border px-3 py-2">
          <FolderCog aria-hidden className="size-4 shrink-0 text-fg-3" />
          <span className="min-w-0 flex-1 text-xs break-all text-fg-2">{t('engines.native.folder', { folder: p.folder, size: bytes(p.sizeBytes) })}</span>
          {p.busy ? (
            // Said, not hidden: why it cannot go now (a click asks again: the test may have ended).
            <IconButton label={t('engines.native.removeBusy', { name })} icon={<Trash2 />} size="sm" aria-disabled className="cursor-not-allowed opacity-50" onClick={() => void plan.refetch()} />
          ) : (
            <IconButton
              label={t('engines.native.remove', { name })}
              icon={<Trash2 />}
              size="sm"
              disabled={remove.isPending}
              onClick={() => {
                setConfirm(true);
                // Fresh size and state in the confirmation.
                void plan.refetch();
              }}
            />
          )}
        </div>
      )}
      {remove.isError && <ErrorCallout error={remove.error} />}
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title={t('engines.native.removeTitle', { name })}
        description={t('engines.native.removeBody', { name, folder: p.folder, size: bytes(p.sizeBytes), files: p.files })}
        confirmLabel={t('engines.native.removeConfirm')}
        cancelLabel={t('common.cancel')}
        onConfirm={() => remove.mutate()}
      />
    </>
  );
}
