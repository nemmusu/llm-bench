import { useState } from 'react';
import { toast } from 'sonner';
import type { RunResult } from '../../../contract/results';
import { useI18n } from '../../i18n';
import { saveTextFile } from '../../lib/export/save';
import { SHEET_FORMATS, sheetRequest, type SheetCompare, type SheetFormat } from '../../lib/export/sheet';
import { Button } from '../ui/button';
import { Dialog, DialogClose, DialogContent } from '../ui/dialog';
import { Field, Input, Textarea } from '../ui/input';
import { SegmentedControl } from '../ui/segmented-control';
import { Select } from '../ui/select';

export interface SheetDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The result the sheet is about (outside a comparison). */
  run?: RunResult;
  /** From the Compare page: every item; the dialog asks which one the sheet is about (default: the last). */
  compare?: Omit<SheetCompare, 'subject'>;
}

/** "Scheda da condividere": optional service name, address and notes, then Markdown or HTML. */
export function SheetDialog({ open, onOpenChange, run, compare }: SheetDialogProps) {
  const f = useI18n();
  const { t } = f;
  const [service, setService] = useState('');
  const [address, setAddress] = useState('');
  const [notes, setNotes] = useState('');
  const [format, setFormat] = useState<SheetFormat>('markdown');
  const [subject, setSubject] = useState(compare ? compare.items.length - 1 : 0);
  // A comparison that lost items since: the last one.
  const about = compare ? Math.min(subject, compare.items.length - 1) : 0;
  const save = async () => {
    try {
      const common = { service, address, notes, appVersion: __APP_VERSION__, now: new Date() };
      const req = sheetRequest(compare ? { ...common, run: compare.items[about]!.run, compare: { ...compare, subject: about } } : { ...common, run: run! }, format, f);
      const where = await saveTextFile(req);
      if (!where) return;
      toast.success(t('sheet.saved', { file: where }));
      onOpenChange(false);
    } catch {
      toast.error(t('sheet.failed'));
    }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title={t('sheet.dialogTitle')}
        description={compare ? t('sheet.dialogBodyCompare') : t('sheet.dialogBody')}
        footer={
          <>
            <DialogClose asChild>
              <Button variant="secondary">{t('common.cancel')}</Button>
            </DialogClose>
            <Button variant="primary" onClick={() => void save()}>
              {t('sheet.save')}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          {compare && (
            <Field label={t('sheet.about')} hint={t('sheet.aboutHint')}>
              {({ id, describedBy }) => (
                <Select
                  id={id}
                  aria-describedby={describedBy}
                  value={String(about)}
                  onValueChange={(v) => setSubject(Number(v))}
                  options={compare.names.map((name, i) => ({ value: String(i), label: name }))}
                />
              )}
            </Field>
          )}
          <Field label={t('sheet.service')} hint={t('sheet.optional')}>
            {({ id, describedBy }) => <Input id={id} aria-describedby={describedBy} value={service} placeholder={t('sheet.servicePlaceholder')} onChange={(e) => setService(e.target.value)} autoComplete="off" />}
          </Field>
          <Field label={t('sheet.address')} hint={t('sheet.addressHint')}>
            {({ id, describedBy }) => (
              <Input id={id} aria-describedby={describedBy} value={address} placeholder={t('sheet.addressPlaceholder')} onChange={(e) => setAddress(e.target.value)} className="font-mono text-xs" autoComplete="off" spellCheck={false} />
            )}
          </Field>
          <Field label={t('sheet.notes')} hint={t('sheet.optional')}>
            {({ id, describedBy }) => <Textarea id={id} aria-describedby={describedBy} value={notes} placeholder={t('sheet.notesPlaceholder')} onChange={(e) => setNotes(e.target.value)} />}
          </Field>
          {/* The radio group is named by its own label; this one is for the eye. */}
          <p aria-hidden className="-mb-2 text-sm font-medium text-fg">
            {t('sheet.format')}
          </p>
          <SegmentedControl<SheetFormat>
            label={t('sheet.format')}
            value={format}
            onValueChange={setFormat}
            options={SHEET_FORMATS.map((v) => ({ value: v, label: t(`sheet.formats.${v}`) }))}
            fullWidth
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}
