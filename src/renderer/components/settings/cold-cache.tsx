import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { toast } from 'sonner';
import type { ColdCacheStatus } from '../../../contract/views';
import { useI18n } from '../../i18n';
import { useApi } from '../../lib/api-context';
import { errorData, libKeys, useColdCache } from '../../lib/queries-library';
import { SETTINGS_QUERY_KEY } from '../../lib/settings';
import { ErrorCallout } from '../library/error-callout';
import { Badge } from '../ui/badge';
import { ConfirmDialog } from '../ui/dialog';
import { Skeleton } from '../ui/skeleton';
import { Switch } from '../ui/switch';
import { Row } from './section';

/**
 * "Misure a freddo reali". Linux: automatic. Windows: opt-in that creates (or removes) a scheduled
 * task through one UAC prompt; the core mirrors the choice in settings.coldCacheOptIn.
 */
export function ColdCacheRow() {
  const { t } = useI18n();
  const api = useApi();
  const qc = useQueryClient();
  const cold = useColdCache();
  const id = useId();
  const [ask, setAsk] = useState<'on' | 'off'>();
  const change = useMutation({
    mutationFn: (on: boolean) => (on ? api.post<ColdCacheStatus>('/api/cache/windows-task') : api.del<ColdCacheStatus>('/api/cache/windows-task')),
    onSuccess: (status, on) => {
      qc.setQueryData(libKeys.cold, status);
      toast.success(t(on ? 'settings.cold.enabled' : 'settings.cold.disabled'));
    },
    onError: (e) => {
      if (errorData(e).code === 'CANCELLED') toast(t('settings.cold.declined'));
    },
    onSettled: () => void qc.invalidateQueries({ queryKey: SETTINGS_QUERY_KEY }),
  });

  let control;
  let hint = t('settings.cold.hintWindows');
  if (!cold.data) control = cold.isError ? <span className="text-sm text-fg-3">–</span> : <Skeleton className="h-6 w-24" />;
  else if (cold.data.automatic) {
    hint = t('settings.cold.hintLinux');
    control = <Badge tone="success">{t('settings.cold.automatic')}</Badge>;
  } else if (cold.data.windowsTaskInstalled === undefined) {
    hint = t('settings.cold.hintNone');
    control = <Badge>{t('settings.cold.unavailable')}</Badge>;
  } else {
    control = <Switch id={id} checked={cold.data.windowsTaskInstalled} disabled={change.isPending} onCheckedChange={(on) => setAsk(on ? 'on' : 'off')} />;
  }

  return (
    <>
      <Row label={t('settings.cold.label')} hint={hint} htmlFor={id} control={control} />
      {change.isError && errorData(change.error).code !== 'CANCELLED' && <ErrorCallout error={change.error} className="mb-3" />}
      <ConfirmDialog
        open={ask !== undefined}
        onOpenChange={(o) => !o && setAsk(undefined)}
        title={t(ask === 'off' ? 'settings.cold.offTitle' : 'settings.cold.onTitle')}
        description={t(ask === 'off' ? 'settings.cold.offBody' : 'settings.cold.onBody')}
        confirmLabel={t(ask === 'off' ? 'settings.cold.offConfirm' : 'settings.cold.onConfirm')}
        cancelLabel={t('common.cancel')}
        tone="primary"
        onConfirm={() => change.mutate(ask === 'on')}
      />
    </>
  );
}
