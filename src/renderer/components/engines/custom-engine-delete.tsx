/**
 * "Elimina" of a saved engine. What LLM Bench added for it (the checkout it cloned and built, the Docker
 * image it pulled) can be removed from here with it — where, how big and the command are said first —
 * or the engine only forgotten, its files left where they are. Anything else (a program, a folder or an
 * image of the user's own) is only forgotten.
 */
import { toast } from 'sonner';
import type { CustomEngine } from '../../../contract/custom-engines';
import { useI18n } from '../../i18n';
import { useCustomEngineRemovePlan, useDeleteCustomEngine } from '../../lib/queries-engines';
import { ErrorCallout } from '../library/error-callout';
import { Button } from '../ui/button';
import { CodeBlock } from '../ui/code-block';
import { Dialog, DialogClose, DialogContent } from '../ui/dialog';
import { Skeleton } from '../ui/skeleton';

export function CustomEngineDelete({ engine, open, onOpenChange }: { engine: Pick<CustomEngine, 'id' | 'name'>; open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t, bytes } = useI18n();
  const plan = useCustomEngineRemovePlan(engine.id, open);
  const remove = useDeleteCustomEngine();
  const files = plan.data?.files;
  const where = files?.distro ? `${files.target} · ${files.distro}` : (files?.target ?? '');
  const go = (withFiles: boolean) =>
    remove.mutate(
      { id: engine.id, ...(withFiles ? { files: true } : {}) },
      {
        onSuccess: () => {
          onOpenChange(false);
          toast.success(t(withFiles ? 'engines.custom.deletedWithFiles' : 'engines.custom.deleted'));
        },
      },
    );
  const body = () => {
    if (!files) return <p>{t('engines.custom.deleteBody')}</p>;
    if (files.kind === 'image') return <p>{t('engines.custom.deleteImageBody', { image: files.target, size: bytes(files.sizeBytes!) })}</p>;
    return <p>{files.sizeBytes ? t('engines.custom.deleteFolderBody', { dir: where, size: bytes(files.sizeBytes) }) : t('engines.custom.deleteFolderBodyNoSize', { dir: where })}</p>;
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title={t('engines.custom.deleteTitle', { name: engine.name })}
        size="md"
        footer={
          <>
            <DialogClose asChild>
              <Button>{t('common.cancel')}</Button>
            </DialogClose>
            {files ? (
              <>
                <Button onClick={() => go(false)} disabled={remove.isPending}>
                  {t('engines.custom.forgetOnly')}
                </Button>
                <Button variant="danger" onClick={() => go(true)} disabled={remove.isPending}>
                  {t('engines.custom.deleteWithFiles')}
                </Button>
              </>
            ) : (
              <Button variant="danger" onClick={() => go(false)} disabled={remove.isPending || plan.isPending}>
                {t('engines.custom.deleteConfirm')}
              </Button>
            )}
          </>
        }
      >
        <div className="flex flex-col gap-3 text-sm text-fg-2">
          {plan.isPending ? <Skeleton className="h-16" /> : body()}
          {files && <CodeBlock single label={t('engines.custom.deleteCommand')} commands={{ powershell: files.command, bash: files.command }} />}
          {remove.isError && <ErrorCallout error={remove.error} />}
        </div>
      </DialogContent>
    </Dialog>
  );
}
