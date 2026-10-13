/**
 * A running server on the Server page: what it is (model, engine, configuration in words), where
 * other programs reach it (address, model name, key on the network, ready-to-paste snippets), how
 * long it has been on and how much VRAM it took, and Ferma / Riavvia / Log.
 */
import { Bookmark, Copy, Eye, EyeOff, Globe, Laptop, RotateCcw, ScrollText, Square } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import type { ServerInfo } from '../../../contract/api';
import { useI18n } from '../../i18n';
import { cn } from '../../lib/cn';
import { useServerApiKey, useServerLog } from '../../lib/queries-servers';
import { MIB_PER_GB, prettyEngineLabel } from '../bench/format';
import { LoadLine } from '../bench/load-line';
import { copyText } from '../bench/servers';
import { useConfigLabel } from '../presets/config-label';
import { Badge } from '../ui/badge';
import { Button, IconButton } from '../ui/button';
import { Card } from '../ui/card';
import { CodeBlock } from '../ui/code-block';
import { Dialog, DialogContent } from '../ui/dialog';
import { SegmentedControl } from '../ui/segmented-control';
import { StatusDot } from '../ui/status-dot';
import { clientSettings, httpSnippets, masked, pythonSnippet, uptimeParts, type SnippetTarget } from './snippets';

/** Re-renders every `ms` (uptime). */
export function useNow(ms: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}

/** "3 min", "2 h 05 min", "1 g 4 h". */
export function useUptime(): (startedAt: string, now: number) => string {
  const { t } = useI18n();
  return (startedAt, now) => {
    const { days, hours, minutes } = uptimeParts(now - new Date(startedAt).getTime());
    if (days) return t('servers.card.uptimeDays', { d: days, h: hours });
    if (hours) return t('servers.card.uptimeHours', { h: hours, m: String(minutes).padStart(2, '0') });
    return minutes ? t('servers.card.uptimeMinutes', { m: minutes }) : t('servers.card.uptimeNow');
  };
}

/** A value with its copy button ("URL base", "Nome del modello", "Chiave API"). */
export function CopyField({ label, value, shown, copyLabel, icon, extra }: { label: string; value: string; shown?: string; copyLabel: string; icon?: ReactNode; extra?: ReactNode }) {
  const { t } = useI18n();
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="text-xs font-medium text-fg-3">{label}</span>
      <div className="flex items-center gap-2 rounded-md border border-border bg-surface-2 py-1 pr-1 pl-3">
        {icon}
        <code className="min-w-0 flex-1 truncate font-mono text-xs text-fg" title={shown ?? value}>
          {shown ?? value}
        </code>
        {extra}
        <IconButton size="sm" label={copyLabel} icon={<Copy />} onClick={() => void copyText(value, t('common.copied'), t('common.copyFailed'))} />
      </div>
    </div>
  );
}

type SnippetKind = 'http' | 'python' | 'client';

/** "Come usarlo": curl / Invoke-RestMethod, the OpenAI Python SDK, the settings of any OpenAI client. */
function Snippets({ target }: { target: SnippetTarget }) {
  const { t } = useI18n();
  const [kind, setKind] = useState<SnippetKind>('http');
  const shown = masked(target);
  const labels = { url: t('servers.card.baseUrl'), key: t('servers.card.apiKey'), model: t('servers.card.modelName'), noKey: t('servers.card.snippets.noKey') };
  const noKeyComment = t('servers.card.snippets.noKeyComment');
  const copyAll = (text: string) => void copyText(text, t('common.copied'), t('common.copyFailed'));
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs font-medium text-fg-3">{t('servers.card.snippets.label')}</span>
        <SegmentedControl<SnippetKind>
          size="sm"
          label={t('servers.card.snippets.label')}
          value={kind}
          onValueChange={setKind}
          options={[
            { value: 'http', label: t('servers.card.snippets.http') },
            { value: 'python', label: t('servers.card.snippets.python') },
            { value: 'client', label: t('servers.card.snippets.client') },
          ]}
        />
      </div>
      {kind === 'http' && <CodeBlock commands={httpSnippets(shown)} label={t('servers.card.snippets.http')} />}
      {kind === 'python' && (
        <div className="relative">
          <CodeBlock commands={{ powershell: pythonSnippet(shown, noKeyComment), bash: pythonSnippet(shown, noKeyComment) }} label={t('servers.card.snippets.python')} single />
        </div>
      )}
      {kind === 'client' && (
        <div className="flex flex-col gap-2 rounded-lg border border-border bg-surface-2 px-4 py-3">
          <p className="text-xs text-fg-3">{t('servers.card.snippets.clientHint')}</p>
          <pre className="font-mono text-xs leading-5 whitespace-pre-wrap text-fg">{clientSettings(shown, labels)}</pre>
          <Button size="sm" className="self-start" onClick={() => copyAll(clientSettings(target, labels))}>
            <Copy aria-hidden />
            {t('servers.card.snippets.copySettings')}
          </Button>
        </div>
      )}
      {target.apiKey && kind !== 'client' && (
        <Button size="sm" variant="ghost" className="self-start" onClick={() => copyAll(kind === 'http' ? httpSnippets(target)[window.gpubench?.platform === 'win32' || !window.gpubench ? 'powershell' : 'bash'] : pythonSnippet(target, noKeyComment))}>
          <Copy aria-hidden />
          {t('servers.card.snippets.copyWithKey')}
        </Button>
      )}
      {target.apiKey && <p className="text-xs text-fg-3">{t('servers.card.snippets.keyHidden')}</p>}
    </div>
  );
}

/** "Log": the engine's last lines (the key hidden by the core), read again every 2 s while open. */
function LogDialog({ server, open, onOpenChange }: { server: ServerInfo; open: boolean; onOpenChange: (o: boolean) => void }) {
  const { t } = useI18n();
  const log = useServerLog(server.id, open);
  const lines = log.data?.lines ?? [];
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open && (
        <DialogContent size="xl" title={t('servers.card.logTitle', { name: server.presetName ?? server.modelLabel })} description={t('servers.card.logHint')}>
          <pre role="log" aria-label={t('servers.card.log')} className="max-h-[60vh] overflow-auto rounded-lg border border-border bg-surface-2 px-4 py-3 font-mono text-[12px] leading-5 whitespace-pre-wrap break-all text-fg-2">
            {lines.length ? lines.join('\n') : t('servers.card.logEmpty')}
          </pre>
        </DialogContent>
      )}
    </Dialog>
  );
}

export interface ServerCardProps {
  server: ServerInfo;
  onStop: (s: ServerInfo) => void;
  onRestart: (s: ServerInfo) => void;
  /** "Salva come preset" (servers not started from one). */
  onSave?: (s: ServerInfo) => void;
  now: number;
}

export function ServerCard({ server: s, onStop, onRestart, onSave, now }: ServerCardProps) {
  const f = useI18n();
  const { t, number } = f;
  const configLabel = useConfigLabel();
  const uptime = useUptime();
  const [logOpen, setLogOpen] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const lan = s.network === 'lan';
  const key = useServerApiKey(lan).data?.key;
  const name = s.presetName ?? s.modelLabel;
  const loading = s.loading !== undefined;
  const config = configLabel(s.params, s.engineKind, { blockCount: s.blockCount }).text;
  const url = lan ? (s.lanUrls[0] ?? s.openaiUrl) : s.openaiUrl;
  const target: SnippetTarget = { url, model: s.modelName, ...(lan && key ? { apiKey: key } : {}), greeting: t('servers.card.snippets.greeting') };
  return (
    <Card className={cn('flex min-w-0 flex-col', loading && 'border-warning/40')}>
      <section aria-label={t('servers.card.label', { name, port: s.port })} className="flex flex-col gap-4 p-card">
        <header className="flex flex-wrap items-start gap-3">
          <span aria-hidden className={cn('mt-0.5 grid size-9 shrink-0 place-items-center rounded-lg', loading ? 'bg-warning-soft text-warning-text' : 'bg-success-soft text-success-text')}>
            {lan ? <Globe className="size-[18px]" /> : <Laptop className="size-[18px]" />}
          </span>
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <h3 className="truncate text-md font-semibold text-fg">{name}</h3>
            <p className="truncate text-sm text-fg-2">
              {s.presetName ? `${s.modelLabel} · ` : ''}
              {prettyEngineLabel(s.engineLabel)}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge tone={loading ? 'warning' : 'success'} size="sm">
              <StatusDot tone={loading ? 'warning' : 'success'} pulse={loading} />
              {loading ? t('servers.card.loading') : t('servers.card.ready')}
            </Badge>
            <Badge tone={lan ? 'info' : 'neutral'} size="sm">
              {lan ? t('servers.card.lan') : t('servers.card.local')}
            </Badge>
          </div>
        </header>

        <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-4">
          <div className="flex flex-col gap-0.5">
            <dt className="text-xs text-fg-3">{t('servers.card.port')}</dt>
            <dd className="font-semibold text-fg tabular-nums">{s.port}</dd>
          </div>
          <div className="flex flex-col gap-0.5">
            <dt className="text-xs text-fg-3">{t('servers.card.contextTokens')}</dt>
            <dd className="font-semibold text-fg tabular-nums">{s.contextSize !== undefined ? f.integer(s.contextSize) : '–'}</dd>
          </div>
          <div className="flex flex-col gap-0.5">
            <dt className="text-xs text-fg-3">{t('servers.card.vramGb')}</dt>
            <dd className="font-semibold text-fg tabular-nums">{s.vramMiB !== undefined ? number(s.vramMiB / MIB_PER_GB, 1) : '–'}</dd>
          </div>
          <div className="flex flex-col gap-0.5">
            <dt className="text-xs text-fg-3">{t('servers.card.uptime')}</dt>
            <dd className="font-semibold text-fg tabular-nums">{uptime(s.startedAt, now)}</dd>
          </div>
          <div className="col-span-2 flex flex-col gap-0.5 sm:col-span-4">
            <dt className="text-xs text-fg-3">{t('servers.card.config')}</dt>
            <dd className="text-fg-2">{config}</dd>
          </div>
        </dl>

        {loading && s.loading ? (
          <LoadLine progress={s.loading} engineKind={s.engineKind} />
        ) : (
          <div className="flex flex-col gap-3">
            <div className="grid gap-3 lg:grid-cols-2">
              <CopyField label={t('servers.card.baseUrl')} value={url} copyLabel={t('servers.card.copyBaseUrl', { name })} />
              <CopyField label={t('servers.card.modelName')} value={s.modelName} copyLabel={t('servers.card.copyModel', { name })} />
            </div>
            {lan && (
              <div className="grid gap-3 lg:grid-cols-2">
                {key && (
                  <CopyField
                    label={t('servers.card.apiKey')}
                    value={key}
                    shown={showKey ? key : masked({ ...target, apiKey: key }).apiKey!}
                    copyLabel={t('servers.card.copyKey')}
                    extra={<IconButton size="sm" label={showKey ? t('servers.network.hide') : t('servers.network.show')} icon={showKey ? <EyeOff /> : <Eye />} onClick={() => setShowKey((v) => !v)} />}
                  />
                )}
                <div className="flex min-w-0 flex-col gap-1">
                  <span className="text-xs font-medium text-fg-3">{t('servers.card.lanUrls')}</span>
                  <ul className="flex flex-col gap-0.5 font-mono text-xs text-fg-2">
                    {s.lanUrls.length ? s.lanUrls.map((u) => <li key={u}>{u}</li>) : <li className="font-sans">{t('servers.network.noAddresses')}</li>}
                  </ul>
                </div>
              </div>
            )}
            <Snippets target={target} />
          </div>
        )}
      </section>
      <footer className="mt-auto flex flex-wrap items-center gap-2 border-t border-border px-card py-3">
        <Button size="sm" variant="danger-outline" onClick={() => onStop(s)} aria-label={t('servers.card.stopNamed', { name })}>
          <Square aria-hidden />
          {t('servers.card.stop')}
        </Button>
        <Button size="sm" onClick={() => onRestart(s)} disabled={loading} aria-label={t('servers.card.restartNamed', { name })}>
          <RotateCcw aria-hidden />
          {t('servers.card.restart')}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setLogOpen(true)} aria-label={t('servers.card.logNamed', { name })}>
          <ScrollText aria-hidden />
          {t('servers.card.log')}
        </Button>
        {onSave && !s.presetId && (
          <Button size="sm" variant="ghost" className="ml-auto" onClick={() => onSave(s)}>
            <Bookmark aria-hidden />
            {t('servers.card.saveAsPreset')}
          </Button>
        )}
      </footer>
      <LogDialog server={s} open={logOpen} onOpenChange={setLogOpen} />
    </Card>
  );
}
