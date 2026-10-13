/**
 * "Cosa verrà avviato": the exact plan of the choices (context and where it comes from, VRAM with a
 * note when other programs hold memory right now, what is fetched first, warnings, the address and
 * the exact command), with "Avvia" and "Salva come preset". Always visible next to the steps.
 */
import { Link } from '@tanstack/react-router';
import { Bookmark, Loader, Play } from 'lucide-react';
import type { ServerPlan } from '../../../../contract/api';
import type { EngineKind } from '../../../../contract/engines';
import type { AppErrorData } from '../../../../contract/errors';
import { useI18n } from '../../../i18n';
import { ErrorCard } from '../../bench/error-card';
import { MIB_PER_GB } from '../../bench/format';
import type { Need } from '../../bench/needs';
import { FitSummary, PlanWarnings } from '../../bench/plan-card';
import { NeedList } from '../../bench/start-dialogs';
import { useConfigLabel } from '../../presets/config-label';
import { Button } from '../../ui/button';
import { Card } from '../../ui/card';
import { CodeBlock } from '../../ui/code-block';
import { buildLabel, depthLabel, kvName } from '../../tune/tune-format';

/** "Contesto 64K e cache q4_0 dal test «Trova le impostazioni migliori» del 07/10", with a link to that result. */
function TunedContext({ tuned }: { tuned: NonNullable<ServerPlan['tuned']> }) {
  const f = useI18n();
  const date = new Intl.DateTimeFormat(f.locale, { day: '2-digit', month: '2-digit' }).format(new Date(tuned.createdAt));
  const what = { ctx: depthLabel(tuned.contextSize, f), kv: kvName(tuned.kvCacheType, f), date };
  return (
    <>
      {tuned.users !== undefined ? f.t('servers.flow.summary.contextTunedUsers', { ...what, users: tuned.users }) : f.t('servers.flow.summary.contextTuned', what)}{' '}
      <Link to="/results/$runId" params={{ runId: tuned.runId }} className="rounded-xs font-medium text-accent-text underline-offset-4 hover:underline focus-ring">
        {f.t('servers.flow.summary.contextTunedLink')}
      </Link>
      {tuned.otherBuild && <span className="mt-1 block text-warning-text">{f.t('servers.flow.summary.otherBuild', { build: buildLabel(tuned.otherBuild.build, f), current: buildLabel(tuned.otherBuild.current, f) })}</span>}
    </>
  );
}

/** Warnings said elsewhere: the port's next to its field, a fork's missing flags in "Comandi personalizzati". */
const SHOWN_ELSEWHERE = new Set(['port_taken', 'port_ours']);

export interface SummaryProps {
  plan: ServerPlan | undefined;
  planning: boolean;
  error: AppErrorData | undefined;
  needs: Need[];
  engineKind: EngineKind | undefined;
  engineName: string;
  /** The user chose the settings (a test, a preset, custom): the context is theirs. */
  own: boolean;
  canStart: boolean;
  editing: boolean;
  onStart: () => void;
  onSave: () => void;
}

export function Summary(p: SummaryProps) {
  const f = useI18n();
  const { t, integer, number } = f;
  const configLabel = useConfigLabel();
  const plan = p.plan;
  const fit = plan?.fit;
  const busy = fit?.levelNow !== undefined && fit.levelNow !== fit.level && (fit.busyMiB ?? 0) > 0;
  const warnings = plan?.warnings.filter((w) => !SHOWN_ELSEWHERE.has(w.code)) ?? [];
  const address = plan ? (plan.network === 'lan' ? (plan.lanUrls?.[0] ?? `http://0.0.0.0:${plan.port}/v1`) : `http://127.0.0.1:${plan.port}/v1`) : undefined;
  return (
    <Card className="flex flex-col">
      <div className="flex items-center gap-2 px-card pt-card">
        <h2 className="text-md font-semibold tracking-[-0.01em]">{t('servers.flow.summary.title')}</h2>
        {p.planning && <Loader aria-label={t('servers.flow.planning')} className="size-4 animate-spin text-accent" />}
      </div>
      <div className="flex flex-col gap-4 p-card">
        {p.error ? (
          <ErrorCard error={p.error} headingLevel={3} />
        ) : !plan ? (
          <p className="text-sm text-fg-3">{t('servers.flow.summary.noPlan')}</p>
        ) : (
          <>
            <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
              <div className="flex flex-col gap-0.5">
                <dt className="text-xs text-fg-3">{t('servers.flow.summary.engine')}</dt>
                <dd className="font-medium text-fg">{p.engineName}</dd>
              </div>
              <div className="flex flex-col gap-0.5">
                <dt className="text-xs text-fg-3">{t('servers.flow.summary.context')}</dt>
                <dd className="font-semibold text-fg tabular-nums">{plan.contextSize !== undefined ? integer(plan.contextSize) : '–'}</dd>
              </div>
              <div className="flex flex-col gap-0.5 sm:col-span-2">
                <dt className="text-xs text-fg-3">{t('servers.flow.summary.settings')}</dt>
                <dd className="text-fg-2">{configLabel(plan.params, p.engineKind ?? 'llamacpp-native').text}</dd>
                <dd className="text-xs text-fg-3">{!p.own && plan.tuned ? <TunedContext tuned={plan.tuned} /> : t(p.own ? 'servers.flow.summary.contextOwn' : 'servers.flow.summary.contextAuto')}</dd>
              </div>
              <div className="flex flex-col gap-0.5 sm:col-span-2">
                <dt className="text-xs text-fg-3">{t('servers.flow.summary.address')}</dt>
                <dd className="font-mono text-xs text-fg">{address}</dd>
              </div>
              {fit && (
                <div className="flex flex-col gap-1 sm:col-span-2">
                  <dt className="text-xs text-fg-3">{t('servers.flow.summary.fit')}</dt>
                  <dd>
                    <FitSummary fit={fit} />
                  </dd>
                  {busy && (
                    <dd className="text-xs text-warning-text">
                      {t('servers.flow.summary.busyNow', { busy: `${number(fit.busyMiB! / MIB_PER_GB, 1)} GB`, verdict: t(`fit.${fit.levelNow!}`).toLocaleLowerCase(f.locale) })}
                    </dd>
                  )}
                </div>
              )}
            </dl>
            {p.needs.length > 0 && (
              <div className="flex flex-col gap-2">
                <p className="text-xs font-medium text-fg-3">{t('servers.flow.summary.needs')}</p>
                <NeedList needs={p.needs} mode="serve" />
              </div>
            )}
            {warnings.length > 0 && <PlanWarnings warnings={warnings} />}
            <div className="flex flex-col gap-1.5">
              <p className="text-xs font-medium text-fg-3">{t('servers.flow.summary.command')}</p>
              <CodeBlock commands={plan.command} label={t('servers.flow.summary.command')} />
            </div>
          </>
        )}
        <p className="text-xs text-fg-3">{t('servers.flow.summary.hint')}</p>
      </div>
      <div className="mt-auto flex flex-wrap items-center justify-end gap-2 border-t border-border px-card py-3">
        <Button onClick={p.onSave} disabled={!plan}>
          <Bookmark aria-hidden />
          {t(p.editing ? 'servers.flow.summary.update' : 'servers.flow.summary.save')}
        </Button>
        <Button variant="primary" size="lg" onClick={p.onStart} disabled={!p.canStart}>
          <Play aria-hidden className="fill-current" />
          {t(p.needs.length ? 'servers.flow.summary.startDownload' : 'servers.flow.summary.start')}
        </Button>
      </div>
    </Card>
  );
}
