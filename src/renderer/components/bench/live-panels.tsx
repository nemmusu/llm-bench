/**
 * Live screen panels for every run: the server configuration in use (with its exact command) and
 * the measurements so far, one row per prompt length / depth / number of users.
 */
import { ChevronDown, Copy } from 'lucide-react';
import { Collapsible } from 'radix-ui';
import { useState, type ReactNode } from 'react';
import type { EngineKind } from '../../../contract/engines';
import type { CurrentStep, LivePoint, RunLaunch } from '../../../contract/events';
import type { LatencyPoint, Scenario } from '../../../contract/results';
import { useI18n } from '../../i18n';
import { cn } from '../../lib/cn';
import { useConfigLabel } from '../presets/config-label';
import { Button } from '../ui/button';
import { Card } from '../ui/card';
import { CodeBlock, defaultShellFor } from '../ui/code-block';
import { HelpTip } from '../ui/help-tip';
import { UsersTable } from './concurrency-users';
import { prefillStat, prettyEngineLabel } from './format';
import { MeasureTable, type MeasureRow } from './measure-table';
import { copyText } from '../../lib/clipboard';

/** "Configurazione del server": engine, settings in words, and the exact command to copy. */
export function LiveConfig({ launch, engineKind }: { launch: RunLaunch | undefined; engineKind: EngineKind }) {
  const { t } = useI18n();
  const label = useConfigLabel();
  const [open, setOpen] = useState(false);
  const title = t('run.config.title');
  if (!launch) {
    return (
      <Card className="flex flex-col gap-2 p-card">
        <h2 className="text-md font-semibold tracking-[-0.01em]">{title}</h2>
        <p className="text-sm text-fg-3">{t('run.config.waiting')}</p>
      </Card>
    );
  }
  const params = launch.params.contextSize === undefined && launch.contextSize !== undefined ? { ...launch.params, contextSize: launch.contextSize } : launch.params;
  const shell = defaultShellFor(window.gpubench?.platform ?? 'win32');
  return (
    <Collapsible.Root open={open} onOpenChange={setOpen} asChild>
      <Card className="flex flex-col overflow-hidden">
        <div className="flex flex-col gap-3 p-card">
          <div className="flex items-center gap-1.5">
            <h2 className="text-md font-semibold tracking-[-0.01em]">{title}</h2>
            <HelpTip term={title}>{t('run.config.help')}</HelpTip>
          </div>
          <dl className="flex flex-col gap-2 text-sm">
            <div className="flex flex-col gap-0.5">
              <dt className="text-xs text-fg-3">{t('run.config.engine')}</dt>
              <dd className="font-medium text-fg">{prettyEngineLabel(launch.engineLabel)}</dd>
            </div>
            <div className="flex flex-col gap-0.5">
              <dt className="text-xs text-fg-3">{t('run.config.settings')}</dt>
              <dd className="font-medium text-fg">{label(params, engineKind).text}</dd>
            </div>
          </dl>
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" onClick={() => void copyText(launch.command[shell], t('codeblock.copied'), t('common.copyFailed'))}>
              <Copy aria-hidden />
              {t('run.config.copy')}
            </Button>
            <Collapsible.Trigger asChild>
              <Button size="sm" variant="ghost">
                <ChevronDown aria-hidden className={cn('transition-transform', open && 'rotate-180')} />
                {open ? t('result.launch.hideCommand') : t('result.launch.showCommand')}
              </Button>
            </Collapsible.Trigger>
          </div>
          <p className="text-xs text-fg-3">{t('run.config.serveLater')}</p>
        </div>
        <Collapsible.Content className="px-card pb-card">
          <CodeBlock commands={launch.command} label={t('result.launch.command')} />
        </Collapsible.Content>
      </Card>
    </Collapsible.Root>
  );
}

type LatencyLive = Extract<LivePoint, { stepKind: 'latency' | 'context-sweep' | 'tune-probe' | 'tune-screen' }>;

export interface LivePointsProps {
  points: readonly LivePoint[];
  current: CurrentStep | undefined;
  scenario: Scenario | undefined;
  /** Tune runs: only the points of the launch in progress. */
  tune?: boolean;
}

/** "Misure finora": rows fill in as the repetitions come in; the one in progress is highlighted. */
export function LivePoints({ points, current, scenario, tune }: LivePointsProps) {
  const f = useI18n();
  const { t, number, integer } = f;
  const latencyLike = points.filter((p): p is LatencyLive => p.stepKind !== 'concurrency' && p.stepKind !== 'sessions');
  const lastAttempt = Math.max(-1, ...latencyLike.map((p) => p.attempt ?? -1));
  const mine = tune ? latencyLike.filter((p) => (p.attempt ?? -1) === lastAttempt) : latencyLike;
  const latency = mine.filter((p) => p.stepKind === 'latency').map((p) => p.point);
  const depths = mine.filter((p) => p.stepKind !== 'latency').map((p) => p.point);
  const users = points.flatMap((p) => (p.stepKind === 'concurrency' ? [p.point] : []));
  const steps = scenario?.steps ?? [];
  const latencyStep = steps.find((s) => s.kind === 'latency');
  const sweepStep = steps.find((s) => s.kind === 'context-sweep');
  const usersStep = steps.find((s) => s.kind === 'concurrency');
  const prompts = latencyStep?.kind === 'latency' ? latencyStep.promptTokens : [];
  const levels = usersStep?.kind === 'concurrency' ? usersStep.levels : [];
  const now = current?.kind;
  // The row in progress is listed before its first measurement.
  const currentPrompt = now === 'latency' ? current!.promptTokens : undefined;
  const currentDepth = now === 'context-sweep' ? (current!.depth ?? current!.promptTokens) : undefined;
  const showLatency = latency.length > 0 || currentPrompt !== undefined;
  const showDepths = depths.length > 0 || currentDepth !== undefined;
  const showUsers = users.length > 0 || now === 'concurrency';
  const title = t('run.points.title');

  const rowsOf = (list: readonly LatencyPoint[], wanted: readonly number[], isCurrent: (n: number) => boolean, total: number | undefined): MeasureRow[] =>
    [...new Set([...wanted, ...list.map((p) => p.promptTokens)])]
      .sort((a, b) => a - b)
      .map((n) => {
        const p = list.find((q) => q.promptTokens === n);
        return {
          key: n,
          current: isCurrent(n),
          muted: !p && !isCurrent(n),
          cells: [
            integer(n),
            p ? integer(prefillStat(p).median) : '–',
            p ? integer(p.ttftMs.median) : '–',
            p ? number(p.decodeTps.median, 1) : '–',
            p ? (total === undefined ? String(p.decodeTps.n) : t('run.points.repsOf', { n: p.decodeTps.n, total })) : isCurrent(n) ? t('run.points.running') : t('run.points.pending'),
          ],
        };
      });
  const head = (first: string) => [
    { label: first },
    { label: t('tune.columns.prefill'), numeric: true },
    { label: t('tune.measures.ttftMs'), numeric: true },
    { label: t('tune.columns.decode'), numeric: true },
    { label: t('run.points.reps'), numeric: true },
  ];

  return (
    <Card className="flex min-w-0 flex-col overflow-hidden">
      <div className="flex items-center gap-1.5 px-card pt-card pb-3">
        <h2 className="text-md font-semibold tracking-[-0.01em]">{title}</h2>
        <HelpTip term={title}>{t('run.points.help')}</HelpTip>
      </div>
      {!showLatency && !showDepths && !showUsers && <p className="px-card pb-card text-sm text-fg-3">{t('run.points.waiting')}</p>}
      {showLatency && (
        <Section title={t('run.points.byPrompt')}>
          <MeasureTable
            caption={t('run.points.byPrompt')}
            columns={head(t('run.points.prompt'))}
            rows={rowsOf(latency, [...prompts, ...(currentPrompt === undefined ? [] : [currentPrompt])], (n) => n === currentPrompt, latencyStep?.kind === 'latency' ? latencyStep.reps : undefined)}
          />
        </Section>
      )}
      {showDepths && (
        <Section title={t(tune ? 'run.points.byAttempt' : 'run.points.byDepth')}>
          <MeasureTable
            caption={t(tune ? 'run.points.byAttempt' : 'run.points.byDepth')}
            columns={head(t('run.points.depth'))}
            rows={rowsOf(depths, currentDepth === undefined ? [] : [currentDepth], (n) => n === currentDepth, sweepStep?.kind === 'context-sweep' && !tune ? sweepStep.reps : undefined)}
          />
        </Section>
      )}
      {showUsers && (
        <Section title={t('run.points.byUsers')}>
          <UsersTable caption={t('run.points.byUsers')} points={users} levels={levels} current={now === 'concurrency' ? current!.concurrency : undefined} />
        </Section>
      )}
    </Card>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="border-t border-border">
      <h3 className="px-card pt-3 pb-1 text-xs font-semibold tracking-wide text-fg-3 uppercase">{title}</h3>
      {children}
    </div>
  );
}
