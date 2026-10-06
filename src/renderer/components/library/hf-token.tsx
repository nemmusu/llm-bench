import { KeyRound, ShieldAlert, ShieldCheck, Trash2 } from 'lucide-react';
import { useId, useState } from 'react';
import { toast } from 'sonner';
import { useI18n } from '../../i18n';
import { useSettings } from '../../lib/settings';
import { Button } from '../ui/button';
import { Input } from '../ui/input';

export interface HfTokenFormProps {
  /** Called after a token was stored (e.g. to retry a gated download). */
  onSaved?: () => void;
  /** "Rimuovi" next to the saved state (Settings); the gated-model prompt hides it. */
  allowClear?: boolean;
}

/**
 * Hugging Face token: typed once, handed to the main process (encrypted with the OS keychain),
 * never shown again. Settings only remembers that one exists.
 */
export function HfTokenForm({ onSaved, allowClear = true }: HfTokenFormProps) {
  const { t } = useI18n();
  const { settings, update } = useSettings();
  const id = useId();
  const [token, setToken] = useState('');
  const [insecure, setInsecure] = useState(false);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true);
    const res = await window.gpubench?.saveHfToken(token.trim());
    setBusy(false);
    if (!res?.ok) {
      toast.error(t('settings.hf.saveFailed'));
      return;
    }
    setToken('');
    setInsecure(!res.secure);
    update({ hasHfToken: true });
    toast.success(t('settings.hfTokenSaved'));
    onSaved?.();
  };

  const clear = async () => {
    await window.gpubench?.clearHfToken();
    setInsecure(false);
    update({ hasHfToken: false });
    toast(t('settings.hf.cleared'));
  };

  if (settings.hasHfToken) {
    return (
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-3">
          <span className={insecure ? 'inline-flex items-center gap-1.5 text-sm text-warning-text' : 'inline-flex items-center gap-1.5 text-sm text-success-text'}>
            {insecure ? <ShieldAlert aria-hidden className="size-4" /> : <ShieldCheck aria-hidden className="size-4" />}
            {insecure ? t('settings.hf.savedInsecure') : t('settings.hf.saved')}
          </span>
          {allowClear && (
            <Button size="sm" variant="danger-outline" onClick={() => void clear()}>
              <Trash2 aria-hidden />
              {t('settings.hf.clear')}
            </Button>
          )}
        </div>
        {insecure && <p className="text-xs text-fg-3">{t('settings.hf.insecureHint')}</p>}
      </div>
    );
  }
  return (
    <form
      className="flex flex-wrap gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <label htmlFor={id} className="sr-only">
        {t('settings.hfToken')}
      </label>
      <Input id={id} type="password" autoComplete="off" spellCheck={false} value={token} onChange={(e) => setToken(e.target.value)} placeholder="hf_…" className="w-64 font-mono" />
      <Button type="submit" disabled={!token.trim() || busy}>
        <KeyRound aria-hidden />
        {t('settings.hf.save')}
      </Button>
    </form>
  );
}
