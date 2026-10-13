/** "Salva come preset": a name and "Avvia all'apertura di GPU Bench"; the rest comes from the server or the flow. */
import { Bookmark } from 'lucide-react';
import { useState } from 'react';
import { useI18n } from '../../i18n';
import { apiErrorData } from '../../lib/queries-runs';
import { Button } from '../ui/button';
import { Checkbox } from '../ui/checkbox';
import { Dialog, DialogContent } from '../ui/dialog';
import { Field, Input } from '../ui/input';

type Save = (name: string, autoStart: boolean) => Promise<void>;

export interface SavePresetDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The port it will remember (said in the description). */
  port: number | undefined;
  defaultName: string;
  /** Saves; a name in use comes back as VALIDATION 'preset_name_taken' and is said next to the field. */
  onSave: Save;
}

function SaveForm({ port, defaultName, onSave, onCancel }: { port: number | undefined; defaultName: string; onSave: Save; onCancel: () => void }) {
  const { t } = useI18n();
  const [name, setName] = useState(defaultName);
  const [autoStart, setAutoStart] = useState(false);
  const [taken, setTaken] = useState(false);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    try {
      await onSave(name.trim(), autoStart);
    } catch (e) {
      if (apiErrorData(e).params?.reason === 'preset_name_taken') setTaken(true);
    } finally {
      setBusy(false);
    }
  };
  const ready = name.trim() !== '' && !busy;
  return (
    <DialogContent
      title={t('servers.flow.save.title')}
      description={t('servers.flow.save.description', { port: port ?? '–' })}
      footer={
        <>
          <Button onClick={onCancel}>{t('common.cancel')}</Button>
          <Button variant="primary" disabled={!ready} onClick={() => void submit()}>
            <Bookmark aria-hidden />
            {t('servers.flow.save.save')}
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (ready) void submit();
        }}
      >
        <Field label={t('servers.flow.save.name')} hint={taken ? <span className="text-danger-text">{t('servers.flow.save.nameTaken')}</span> : undefined}>
          {({ id, describedBy }) => (
            <Input
              id={id}
              aria-describedby={describedBy}
              aria-invalid={taken || undefined}
              value={name}
              maxLength={60}
              placeholder={t('servers.flow.save.namePlaceholder')}
              onChange={(e) => {
                setName(e.target.value);
                setTaken(false);
              }}
            />
          )}
        </Field>
        <label className="flex items-start gap-2.5 text-sm">
          <Checkbox className="mt-0.5" checked={autoStart} onCheckedChange={(v) => setAutoStart(v === true)} />
          <span className="flex flex-col gap-0.5">
            <span className="font-medium text-fg">{t('servers.presets.autoStart')}</span>
            <span className="text-xs text-fg-3">{t('servers.presets.autoStartHint')}</span>
          </span>
        </label>
      </form>
    </DialogContent>
  );
}

export function SavePresetDialog({ open, onOpenChange, port, defaultName, onSave }: SavePresetDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open && <SaveForm port={port} defaultName={defaultName} onSave={onSave} onCancel={() => onOpenChange(false)} />}
    </Dialog>
  );
}
