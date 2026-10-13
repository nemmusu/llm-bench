/**
 * Step 4 of "Avvia un server": the port (stable, so other programs find it again) and, as an advanced
 * option, the local network: every network card and GPU Bench's API key, with a clear warning.
 */
import { Eye, EyeOff, RefreshCw, ShieldAlert } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import type { ServerPlan } from '../../../../contract/api';
import { useI18n } from '../../../i18n';
import { useRegenerateApiKey, useServerApiKey } from '../../../lib/queries-servers';
import { Button, IconButton } from '../../ui/button';
import { Callout } from '../../ui/callout';
import { Field, Input } from '../../ui/input';
import { Switch } from '../../ui/switch';
import { CopyField } from '../server-card';
import { HIDDEN_KEY } from '../snippets';

export interface NetworkStepProps {
  portText: string;
  onPort: (text: string) => void;
  portInvalid: boolean;
  /** The port the plan would use (the placeholder when the field is empty). */
  suggested: number | undefined;
  /** The plan's port warnings ('port_taken', 'port_ours'). */
  warnings: ServerPlan['warnings'];
  lan: boolean;
  onLan: (on: boolean) => void;
  /** The plan's addresses for other devices. */
  lanUrls: readonly string[];
  /** The engine is a command template: no network sharing. */
  lanUnsupported: boolean;
}

/** The key, hidden by default, its copy button, "Genera una nuova chiave", and where it is kept. */
function ApiKey() {
  const { t } = useI18n();
  const key = useServerApiKey(true);
  const regenerate = useRegenerateApiKey();
  const [shown, setShown] = useState(false);
  const info = key.data;
  if (!info) return null;
  return (
    <div className="flex flex-col gap-2">
      <CopyField
        label={t('servers.network.key')}
        value={info.key}
        shown={shown ? info.key : HIDDEN_KEY}
        copyLabel={t('servers.card.copyKey')}
        extra={<IconButton size="sm" label={shown ? t('servers.network.hide') : t('servers.network.show')} icon={shown ? <EyeOff /> : <Eye />} onClick={() => setShown((v) => !v)} />}
      />
      <p className="text-xs text-fg-3">{t('servers.network.keyHint')}</p>
      {info.storage !== 'encrypted' && <p className="text-xs text-warning-text">{t(info.storage === 'plain' ? 'servers.network.storagePlain' : 'servers.network.storageMemory')}</p>}
      <Button
        size="sm"
        variant="ghost"
        className="self-start"
        disabled={regenerate.isPending}
        onClick={() => regenerate.mutate(undefined, { onSuccess: () => toast.success(t('servers.network.regenerated')) })}
      >
        <RefreshCw aria-hidden />
        {t('servers.network.regenerate')}
      </Button>
    </div>
  );
}

export function NetworkStep(p: NetworkStepProps) {
  const { t } = useI18n();
  const portWarning = p.warnings.find((w) => w.code === 'port_taken' || w.code === 'port_ours');
  const hint = p.portInvalid ? (
    <span className="text-danger-text">{t('servers.flow.port.invalid')}</span>
  ) : portWarning ? (
    <span className="text-danger-text">{t(portWarning.code === 'port_taken' ? 'servers.flow.port.taken' : 'servers.flow.port.ours', { port: String(portWarning.params?.port) })}</span>
  ) : (
    t('servers.flow.port.hint')
  );
  return (
    <div className="flex flex-col gap-4">
      <Field label={t('servers.flow.port.label')} hint={hint} className="max-w-xs">
        {({ id, describedBy }) => (
          <Input
            id={id}
            aria-describedby={describedBy}
            aria-invalid={p.portInvalid || portWarning !== undefined || undefined}
            value={p.portText}
            inputMode="numeric"
            placeholder={p.suggested !== undefined ? String(p.suggested) : '8080'}
            onChange={(e) => p.onPort(e.target.value)}
            className="tabular-nums"
            autoComplete="off"
          />
        )}
      </Field>
      <div className="flex items-start gap-3">
        <Switch id="server-lan" checked={p.lan} disabled={p.lanUnsupported} onCheckedChange={p.onLan} aria-describedby="server-lan-hint" />
        <div className="flex flex-col">
          <label htmlFor="server-lan" className="cursor-pointer text-sm font-semibold text-fg">
            {t('servers.network.label')}
          </label>
          <span id="server-lan-hint" className="text-xs text-fg-3">
            {p.lanUnsupported ? t('servers.network.unsupported') : t('servers.network.hint')}
          </span>
        </div>
      </div>
      {p.lan && (
        <div className="flex flex-col gap-4 rounded-xl border border-border bg-surface-2/50 p-4">
          <Callout tone="warning" title={t('servers.network.warningTitle')}>
            {t('servers.network.warningBody')}
          </Callout>
          <ApiKey />
          <div className="flex flex-col gap-1">
            <span className="inline-flex items-center gap-1.5 text-xs font-medium text-fg-3">
              <ShieldAlert aria-hidden className="size-3.5" />
              {t('servers.network.addresses')}
            </span>
            <ul className="flex flex-col gap-0.5 font-mono text-xs text-fg">
              {p.lanUrls.length ? p.lanUrls.map((u) => <li key={u}>{u}</li>) : <li className="font-sans text-fg-2">{t('servers.network.noAddresses')}</li>}
            </ul>
          </div>
        </div>
      )}
    </div>
  );
}
