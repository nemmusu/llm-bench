import { useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useEffect, useRef } from 'react';
import { toast } from 'sonner';
import type { AppNotice } from '../../../contract/app-notices';
import { useI18n } from '../../i18n';
import { useApi } from '../../lib/api-context';
import { useSettings } from '../../lib/settings';

/**
 * The app's one-time notices (contract/app-notices.ts: the data of GPU Bench taken over, a secret
 * that could not be read after the rename): each one a toast that stays until it is closed (or its
 * action used), and only then dismissed in the core, so a window reloaded before anyone read it shows
 * it again. Mounted once by the shell; renders nothing.
 */
export function AppNotices() {
  const { t } = useI18n();
  const api = useApi();
  const navigate = useNavigate();
  const { update } = useSettings();
  const shown = useRef(new Set<string>());
  const notices = useQuery({ queryKey: ['app', 'notices'], queryFn: () => api.get<AppNotice[]>('/api/app/notices'), staleTime: Infinity, retry: false });

  useEffect(() => {
    for (const n of notices.data ?? []) {
      if (shown.current.has(n.id)) continue;
      shown.current.add(n.id);
      const dismiss = () => void api.del(`/api/app/notices/${encodeURIComponent(n.id)}`).catch(() => undefined);
      const sticky = { id: n.id, duration: Infinity, closeButton: true, onDismiss: dismiss };
      if (n.kind === 'data-moved') {
        const body =
          n.mode === 'moved'
            ? t('app.notices.movedBody')
            : [t('app.notices.copiedBody', { from: n.from }), ...(n.enginesIn !== undefined ? [t('app.notices.copiedEngines', { path: n.enginesIn })] : [])].join(' ');
        toast.success(t(n.mode === 'moved' ? 'app.notices.movedTitle' : 'app.notices.copiedTitle'), { ...sticky, description: body });
      } else if (n.secret === 'hf-token') {
        // The token file is gone: the settings must stop saying one is saved.
        update({ hasHfToken: false });
        toast.warning(t(n.renamed ? 'app.notices.hfTokenRenamed' : 'app.notices.hfTokenUnreadable'), {
          ...sticky,
          action: {
            label: t('app.notices.hfTokenAction'),
            onClick: () => {
              dismiss();
              void navigate({ to: '/settings' });
            },
          },
        });
      } else {
        toast.warning(t(n.renamed ? 'app.notices.serverKeyRenamed' : 'app.notices.serverKeyUnreadable'), sticky);
      }
    }
  }, [notices.data, api, t, navigate, update]);

  return null;
}
