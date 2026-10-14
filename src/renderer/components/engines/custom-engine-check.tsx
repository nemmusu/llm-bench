/** What a custom engine is and what its check found, in plain words (cards and the add dialog). */
import { commandLines, commandStepsOf, customEngineKindOf, type CustomEngine, type CustomEngineCheck } from '../../../contract/custom-engines';
import type { EngineKind } from '../../../contract/engines';
import { forkKvTypes } from '../../../contract/kv-cache';
import { useI18n, type Formatters, type MessageKey } from '../../i18n';
import { ErrorCallout } from '../library/error-callout';
import { Callout } from '../ui/callout';
import { NinferProblem } from './ninfer-problem';

/** "llama.cpp · PrismML fork": the kind it runs as, then its name (engine choices, labels). */
export function customEngineLabel(t: Formatters['t'], e: Pick<CustomEngine, 'name' | 'base' | 'run'>): string {
  return `${t(`benchmark.engines.${customEngineKindOf(e)}`)} · ${e.name}`;
}

/** Where it is: the executable or venv, the Docker image, a program's server command, or a NInfer variant's build (and its WSL distro). */
export function customEngineWhere(e: Pick<CustomEngine, 'run'>): string {
  const r = e.run;
  if (r.mode === 'ninfer') return r.distro ? `${r.path} · ${r.distro}` : r.path;
  return r.mode === 'native' ? r.path : r.mode === 'docker' ? r.image : r.template;
}

/** A program's commands in the order they run, each saying when it runs (its card, when it has commands around the server). */
export function CommandList({ run }: { run: Extract<CustomEngine['run'], { mode: 'command' }> }) {
  const { t } = useI18n();
  const { before, after } = commandStepsOf(run);
  const rows = [
    ...before.map((c) => ({ label: t('engines.custom.dialog.previewBefore'), c })),
    { label: t('engines.custom.dialog.previewServer'), c: run.template },
    ...after.map((c) => ({ label: t('engines.custom.dialog.previewAfter'), c })),
  ];
  return (
    <ol className="flex flex-col gap-1 rounded-md bg-surface-2 px-2.5 py-1.5 text-xs">
      {rows.map((r, i) => (
        <li key={i} className="flex min-w-0 flex-col">
          <span className="text-fg-3">{r.label}</span>
          <span className="font-mono break-all text-fg-2">{r.c}</span>
        </li>
      ))}
    </ol>
  );
}

/** An LLM Bench setting in words ("l’ubatch"); an unknown key as it is. */
export function settingText(t: Formatters['t'], setting: string): string {
  const key = `engines.custom.settings.${setting}` as MessageKey;
  const text = t(key);
  return text === key ? setting : text;
}

export interface CheckViewProps {
  check: CustomEngineCheck;
  /** The base's name for "I will use the llama.cpp settings as they are". */
  baseLabel: string;
  /** Where the engine is: an image not pulled yet and a file not found have their own words. */
  run: CustomEngine['run'];
}

/** Runs or not (and why), the version, how many options its --help lists, and what it lacks. */
export function CheckView({ check, baseLabel, run }: CheckViewProps) {
  const { t, integer } = useI18n();
  const { status, missing } = check;
  const notInstalled = status.problems[0] === 'ENGINE_NOT_INSTALLED' && status.problemParams?.reason === undefined;
  if (notInstalled && run.mode === 'docker') {
    return (
      <Callout tone="warning" title={t('engines.custom.check.imageMissing', { image: run.image })}>
        <p>{t('engines.custom.check.imageMissingBody')}</p>
      </Callout>
    );
  }
  // A NInfer variant says why in NInfer's own words (a path without ninfer-serve, a checkout not built yet, a distro gone).
  if (run.mode === 'ninfer' && !status.available) return <NinferProblem status={status} fallback={run.path} />;
  if (notInstalled && run.mode === 'native') {
    return (
      <Callout tone="danger" title={t('engines.custom.check.notFound', { path: run.path })}>
        <p>{t('engines.custom.check.notFoundBody')}</p>
      </Callout>
    );
  }
  if (!status.available) {
    const params = status.problemParams;
    const reason = params?.reason;
    const known = typeof reason === 'string' ? (`engines.custom.problems.${reason}` as MessageKey) : undefined;
    const text = known ? t(known, { path: String(params?.path ?? ''), port: '{port}' }) : undefined;
    // A reason LLM Bench can say in its own words (a command before or after the server: which one), else the error catalog's text.
    if (text !== undefined && text !== known) {
      const which = params?.which;
      const title = which === 'before' || which === 'after' ? t(`engines.custom.problems.inStep.${which}`, { n: Number(params?.n), problem: text }) : text;
      return <Callout tone="danger" title={title} />;
    }
    return <ErrorCallout error={{ code: status.problems[0] ?? 'ENGINE_START_FAILED', message: status.location ?? '', ...(params ? { params } : {}) }} />;
  }
  if (run.mode === 'command') {
    // Every program was found: the server's is the one that matters most.
    const total = commandLines(run).length;
    const path = status.location ?? '';
    return <Callout tone="success" title={total > 1 ? t('engines.custom.check.commandOkSteps', { n: total, path }) : t('engines.custom.check.commandOk', { path })} />;
  }
  const required = missing.filter((m) => m.effect === 'required');
  const optional = missing.filter((m) => m.effect === 'default');
  const title = status.version ? t('engines.custom.check.ok', { version: status.version }) : t('engines.custom.check.okNoVersion');
  // A llama.cpp fork's own KV caches (turbo3…): the forms offer them, the search tries them.
  const extraKv = forkKvTypes(check.kvCacheTypes);
  return (
    <div className="flex flex-col gap-2">
      <Callout tone={required.length ? 'danger' : 'success'} title={required.length ? t('engines.custom.check.requiredTitle') : title}>
        {required.length > 0 ? (
          <ul className="flex flex-col gap-0.5">
            {required.map((m) => (
              <li key={m.flag}>{t('engines.custom.check.requiredFlag', { flag: m.flag, setting: settingText(t, m.setting) })}</li>
            ))}
          </ul>
        ) : (
          <p>{check.flagCount > 0 ? `${t('engines.custom.check.flags', { n: integer(check.flagCount) })}${optional.length === 0 ? ` · ${t('engines.custom.check.allFlags')}` : ''}` : t('engines.custom.check.noHelp', { base: baseLabel })}</p>
        )}
      </Callout>
      {check.kvDtypes && <p className="text-sm text-fg-2">{t('ninfer.variant.kvDtypes', { list: check.kvDtypes.join(', ') })}</p>}
      {extraKv.length > 0 && <p className="text-sm text-fg-2">{t('engines.custom.check.kvExtra', { list: extraKv.join(', ') })}</p>}
      {optional.length > 0 && (
        <Callout tone="warning" title={t('engines.custom.check.missingTitle')}>
          <ul className="flex flex-col gap-0.5">
            {optional.map((m) => (
              <li key={m.flag}>{t('engines.custom.check.missingFlag', { flag: m.flag, setting: settingText(t, m.setting) })}</li>
            ))}
          </ul>
        </Callout>
      )}
    </div>
  );
}

/** The engine kind label of a base + run (for the "runs as" line). */
export function kindText(t: Formatters['t'], kind: EngineKind): string {
  return t(`benchmark.engines.${kind}`);
}
