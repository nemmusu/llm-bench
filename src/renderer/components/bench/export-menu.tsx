import { ChevronDown, FileJson, FileSpreadsheet, FileText, Globe, Share2, Upload } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import type { RunResult } from '../../../contract/results';
import { useI18n } from '../../i18n';
import { EXPORT_FORMATS, exportRequest, type ExportFormat } from '../../lib/export';
import { saveTextFile } from '../../lib/export/save';
import { Button } from '../ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '../ui/dropdown-menu';
import { SheetDialog } from './sheet-dialog';

const ICONS: Record<ExportFormat, ReactNode> = {
  csvIt: <FileSpreadsheet />,
  csv: <FileSpreadsheet />,
  json: <FileJson />,
  markdown: <FileText />,
  html: <Globe />,
};

/** "Esporta": CSV for Italian Excel or standard, JSON, Markdown, standalone HTML, and the "Scheda da condividere". */
export function ExportMenu({ run }: { run: RunResult }) {
  const f = useI18n();
  const { t } = f;
  const [sheet, setSheet] = useState(false);
  const save = async (format: ExportFormat) => {
    try {
      const where = await saveTextFile(exportRequest(run, format, f));
      if (where) toast.success(t('export.done', { format: t(`export.formats.${format}`), file: where }));
    } catch {
      toast.error(t('export.failed'));
    }
  };
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button>
            <Upload aria-hidden />
            {t('export.label')}
            <ChevronDown aria-hidden className="text-fg-3" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          {EXPORT_FORMATS.map((format) => (
            <DropdownMenuItem key={format} onSelect={() => void save(format)}>
              {ICONS[format]}
              <span className="flex flex-col">
                <span>{t(`export.formats.${format}`)}</span>
                <span className="text-xs text-fg-3">{t(`export.hints.${format}`)}</span>
              </span>
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          {/* Opened once the menu has closed and given the focus back, so the dialog keeps it. */}
          <DropdownMenuItem onSelect={() => setTimeout(() => setSheet(true), 0)}>
            <Share2 />
            <span className="flex flex-col">
              <span>{t('sheet.menu')}</span>
              <span className="text-xs text-fg-3">{t('sheet.menuHint')}</span>
            </span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <SheetDialog open={sheet} onOpenChange={setSheet} run={run} />
    </>
  );
}
