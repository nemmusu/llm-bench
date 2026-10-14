/**
 * "Rimuovi" / "Dimentica" on one of NInfer's builds, like every engine LLM Bench adds: what it does is
 * said before asking — the folder LLM Bench built goes (where, how big, the command), a build of the
 * user's own is only forgotten (its files stay), one built by hand in NInfer-all's usual folder is
 * deleted by hand (LLM Bench would find it there again).
 */
import { Trash2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import type { NinferBuildInfo } from '../../../contract/ninfer';
import { useI18n } from '../../i18n';
import { useNinferRemovePlan, useRemoveNinferBuild } from '../../lib/queries-ninfer';
import { ErrorCallout } from '../library/error-callout';
import { Button } from '../ui/button';
import { CodeBlock } from '../ui/code-block';
import { Dialog, DialogClose, DialogContent } from '../ui/dialog';
import { Skeleton } from '../ui/skeleton';

/** "Dimentica" for a build LLM Bench did not make (and not in NInfer-all's usual folder), "Rimuovi" otherwise. */
export function forgetsOnly(info: Pick<NinferBuildInfo, 'build' | 'built' | 'dir'>): boolean {
  return info.built === undefined && !(info.build === 'all' && /\/ninfer-all$/.test(info.dir));
}

export function NinferRemove({ info, name }: { info: NinferBuildInfo; name: string }) {
  const { t, bytes } = useI18n();
  const [open, setOpen] = useState(false);
  const plan = useNinferRemovePlan(info.build, open);
  const remove = useRemoveNinferBuild(info.build);
  const forget = forgetsOnly(info);
  const p = plan.data;
  const where = p?.distro ? `${p.dir} · ${p.distro}` : (p?.dir ?? '');
  // The command it runs (or the one to copy, by hand); none to forget a build.
  const command = p?.command ?? '';
  const confirm = () =>
    remove.mutate(undefined, {
      onSuccess: () => {
        setOpen(false);
        toast.success(t(p?.mode === 'forget' ? 'ninfer.remove.forgotten' : 'ninfer.remove.removed', { name }));
      },
    });
  return (
    <>
      <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>
        <Trash2 aria-hidden />
        {forget ? t('ninfer.remove.forget') : t('ninfer.remove.remove')}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          title={t(p?.mode === 'forget' || (!p && forget) ? 'ninfer.remove.forgetTitle' : 'ninfer.remove.title', { name })}
          size="md"
          footer={
            <>
              <DialogClose asChild>
                <Button>{p?.mode === 'manual' ? t('common.close') : t('common.cancel')}</Button>
              </DialogClose>
              {p && p.mode !== 'manual' && (
                <Button variant="danger" onClick={confirm} disabled={remove.isPending}>
                  {p.mode === 'forget' ? t('ninfer.remove.forget') : t('ninfer.remove.confirm')}
                </Button>
              )}
            </>
          }
        >
          <div className="flex flex-col gap-3 text-sm text-fg-2">
            {plan.isPending && <Skeleton className="h-16" />}
            {plan.isError && <ErrorCallout error={plan.error} />}
            {p?.mode === 'delete' && (
              <>
                <p>{p.sizeBytes ? t('ninfer.remove.deleteBody', { dir: where, size: bytes(p.sizeBytes) }) : t('ninfer.remove.deleteBodyNoSize', { dir: where })}</p>
                <CodeBlock single label={t('ninfer.remove.command')} commands={{ powershell: command, bash: command }} />
              </>
            )}
            {p?.mode === 'forget' && <p>{t('ninfer.remove.forgetBody', { dir: where })}</p>}
            {p?.mode === 'manual' && (
              <>
                <p>{t('ninfer.remove.manualBody', { dir: where })}</p>
                <CodeBlock single label={t('ninfer.remove.command')} commands={{ powershell: command, bash: command }} />
              </>
            )}
            {remove.isError && <ErrorCallout error={remove.error} />}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
