import { ChevronDown, RotateCcw, Server, SlidersHorizontal } from 'lucide-react';
import { Collapsible } from 'radix-ui';
import { useState, type ReactNode } from 'react';
import type { RunResult } from '../../../contract/results';
import { useI18n } from '../../i18n';
import { cn } from '../../lib/cn';
import { Button } from '../ui/button';
import { Card, CardContent } from '../ui/card';
import { CodeBlock } from '../ui/code-block';
import { prettyVariant } from './format';
import type { Rerun } from './rerun';
import { ServeDialog } from './servers';
import { launchSummaryParts } from './summary';

function KeyValue({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-1 py-3 sm:grid-cols-[200px_1fr] sm:gap-4">
      <dt className="text-sm text-fg-3">{label}</dt>
      <dd className="min-w-0 text-sm break-all text-fg">{children}</dd>
    </div>
  );
}

export interface LaunchProps {
  run: RunResult;
  rerun: Rerun | undefined;
  onRerun: () => void;
  onUseSettings: () => void;
}

/** "Come è stato avviato": the sentence for everyone, the exact command, and three ways to reuse it. */
export function Launch({ run, rerun, onRerun, onUseSettings }: LaunchProps) {
  const f = useI18n();
  const { t } = f;
  const [showCommand, setShowCommand] = useState(false);
  const [serveOpen, setServeOpen] = useState(false);
  const parts = launchSummaryParts(run, f);
  const e = run.engine;
  const canServe = e.kind !== 'external' && rerun !== undefined && !rerun.modelMissing;
  const env = Object.entries(run.launch.env);
  return (
    <div className="flex flex-col gap-section">
      <Card className="hero-wash">
        <CardContent className="flex flex-col gap-4 p-7 compact:p-5">
          <p className="text-xs font-semibold tracking-wide text-fg-3 uppercase">{t('result.launch.summaryTitle')}</p>
          <p className="text-xl leading-8 font-medium tracking-[-0.01em] text-balance">
            {parts.map((part, i) => (
              <span key={i}>
                {i > 0 && <span className="mx-2 text-fg-3">·</span>}
                {part}
              </span>
            ))}
          </p>
          <div className="flex flex-wrap gap-2 pt-1">
            <Button variant="primary" onClick={onRerun} disabled={!rerun}>
              <RotateCcw aria-hidden />
              {t('result.launch.rerun')}
            </Button>
            <Button onClick={onUseSettings} disabled={!rerun}>
              <SlidersHorizontal aria-hidden />
              {t('result.launch.useSettings')}
            </Button>
            {canServe && (
              <Button variant="outline" onClick={() => setServeOpen(true)}>
                <Server aria-hidden />
                {t('result.launch.serveOnly')}
              </Button>
            )}
          </div>
          {rerun?.modelMissing && <p className="text-sm text-warning-text">{t('result.launch.modelMissing')}</p>}
        </CardContent>
      </Card>

      <Collapsible.Root open={showCommand} onOpenChange={setShowCommand}>
        <Card className="overflow-hidden">
          <Collapsible.Trigger asChild>
            <button type="button" className="flex w-full items-center justify-between px-card py-3.5 text-left hover:bg-surface-2/60 focus-ring">
              <span className="text-md font-semibold">{showCommand ? t('result.launch.hideCommand') : t('result.launch.showCommand')}</span>
              <ChevronDown aria-hidden className={cn('size-4 text-fg-3 transition-transform', showCommand && 'rotate-180')} />
            </button>
          </Collapsible.Trigger>
          <Collapsible.Content className="px-card pb-card">
            {run.launch.argv.length ? (
              <CodeBlock commands={run.launch.display} label={t('result.launch.command')} />
            ) : (
              <p className="text-sm text-fg-2">{t('result.launch.noCommand')}</p>
            )}
          </Collapsible.Content>
        </Card>
      </Collapsible.Root>

      <Card>
        <dl className="divide-y divide-border px-card py-1">
          {e.executable && (
            <KeyValue label={t('result.launch.executable')}>
              <code className="font-mono text-xs">{e.executable}</code>
            </KeyValue>
          )}
          <KeyValue label={t('result.launch.build')}>
            {[e.name, e.build ?? e.version, e.variant ? prettyVariant(e.variant) : undefined].filter(Boolean).join(' · ')}
          </KeyValue>
          {e.image && (
            <KeyValue label={t('result.launch.image')}>
              <code className="font-mono text-xs">
                {e.image}
                {e.imageDigest ? `@${e.imageDigest}` : ''}
              </code>
            </KeyValue>
          )}
          <KeyValue label={t('result.launch.env')}>
            <code className="font-mono text-xs">{env.length ? env.map(([k, v]) => `${k}=${v}`).join('  ') : t('common.none')}</code>
          </KeyValue>
          {run.launch.cwd && (
            <KeyValue label={t('result.launch.cwd')}>
              <code className="font-mono text-xs">{run.launch.cwd}</code>
            </KeyValue>
          )}
          <KeyValue label={t('result.launch.address')}>
            <code className="font-mono text-xs">{`http://${run.launch.host}:${run.launch.port}`}</code>
          </KeyValue>
          {run.launch.requestExample && (
            <KeyValue label={t('result.launch.request')}>
              <pre className="overflow-x-auto rounded-md bg-surface-2 p-3 font-mono text-xs leading-5 text-fg-2">{JSON.stringify(run.launch.requestExample, null, 2)}</pre>
            </KeyValue>
          )}
          <KeyValue label={t('result.details.app')}>GPU Bench {run.app.version}</KeyValue>
        </dl>
      </Card>

      {canServe && (
        <ServeDialog
          open={serveOpen}
          onOpenChange={setServeOpen}
          request={{ engine: rerun.request.engine, model: rerun.request.model, params: run.launch.params }}
        />
      )}
    </div>
  );
}
