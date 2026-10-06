import { useMutation, useQueryClient } from '@tanstack/react-query';
import { FileDown, FileUp } from 'lucide-react';
import { useRef } from 'react';
import { toast } from 'sonner';
import type { RunSummary } from '../../../contract/results';
import { useI18n } from '../../i18n';
import { useApi } from '../../lib/api-context';
import { libKeys, useAllRuns } from '../../lib/queries-library';
import { ErrorCallout } from '../library/error-callout';
import { Button } from '../ui/button';
import { Row, Section } from './section';

/** Export every result to one .gpubench file (to move or share them) and import such a file back. */
export function DataSection() {
  const { t, integer } = useI18n();
  const api = useApi();
  const qc = useQueryClient();
  const runs = useAllRuns();
  const input = useRef<HTMLInputElement>(null);
  const count = runs.data?.length ?? 0;

  const exportAll = useMutation({
    mutationFn: async () => {
      const bundle = await api.post<unknown>('/api/runs/export', { ids: (runs.data as RunSummary[]).map((r) => r.id) });
      const day = new Date().toISOString().slice(0, 10);
      return window.gpubench?.saveFile({
        defaultName: `gpu-bench-${day}.gpubench`,
        content: JSON.stringify(bundle),
        filters: [{ name: 'GPU Bench', extensions: ['gpubench', 'json'] }],
      });
    },
    onSuccess: (path) => {
      if (path) toast.success(count === 1 ? t('settings.data.exportedOne') : t('settings.data.exported', { n: integer(count) }));
    },
  });

  const importFile = useMutation({
    mutationFn: async (file: File) => {
      let json: unknown;
      try {
        json = JSON.parse(await file.text());
      } catch {
        json = null;
      }
      return api.post<{ imported: number; skipped: number }>('/api/runs/import', json);
    },
    onSuccess: (r) => {
      toast.success(t('settings.data.imported', { n: r.imported, skipped: r.skipped }));
      void qc.invalidateQueries({ queryKey: libKeys.runs });
    },
  });

  return (
    <Section title={t('settings.data.title')} hint={t('settings.data.hint')}>
      <Row
        label={t('settings.data.export')}
        hint={count === 0 ? t('settings.data.nothing') : count === 1 ? t('settings.data.exportHintOne') : t('settings.data.exportHint', { n: integer(count) })}
        control={
          <Button size="sm" disabled={count === 0 || exportAll.isPending} onClick={() => exportAll.mutate()}>
            <FileDown aria-hidden />
            {t('settings.data.exportButton')}
          </Button>
        }
      />
      <Row
        label={t('settings.data.import')}
        hint={t('settings.data.importHint')}
        control={
          <>
            <input
              ref={input}
              type="file"
              accept=".gpubench,.json,application/json"
              hidden
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) importFile.mutate(file);
                e.target.value = '';
              }}
            />
            <Button size="sm" disabled={importFile.isPending} onClick={() => input.current?.click()}>
              <FileUp aria-hidden />
              {t('settings.data.importButton')}
            </Button>
          </>
        }
      />
      {(exportAll.isError || importFile.isError) && <ErrorCallout error={exportAll.error ?? importFile.error} className="mt-3" />}
    </Section>
  );
}
