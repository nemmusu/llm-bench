/** What a custom engine is and what its check found, in plain words (cards and the add dialog). */
import { customEngineKindOf, type CustomEngine, type CustomEngineCheck } from '../../../contract/custom-engines';
import type { EngineKind } from '../../../contract/engines';
import { useI18n, type Formatters, type MessageKey } from '../../i18n';
import { ErrorCallout } from '../library/error-callout';
import { Callout } from '../ui/callout';

/** "llama.cpp · PrismML fork": the kind it runs as, then its name (engine choices, labels). */
export function customEngineLabel(t: Formatters['t'], e: Pick<CustomEngine, 'name' | 'base' | 'run'>): string {
  return `${t(`benchmark.engines.${customEngineKindOf(e)}`)} · ${e.name}`;
}

/** Where it is: the executable or venv, the Docker image, or the command. */
export function customEngineWhere(e: Pick<CustomEngine, 'run'>): string {
  const r = e.run;
  return r.mode === 'native' ? r.path : r.mode === 'docker' ? r.image : r.template;
}

/** A LLM Bench setting in words ("l’ubatch"); an unknown key as it is. */
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
  if (notInstalled && run.mode === 'native') {
    return (
      <Callout tone="danger" title={t('engines.custom.check.notFound', { path: run.path })}>
        <p>{t('engines.custom.check.notFoundBody')}</p>
      </Callout>
    );
  }
  if (!status.available) {
    const reason = status.problemParams?.reason;
    const known = typeof reason === 'string' ? (`engines.custom.problems.${reason}` as MessageKey) : undefined;
    const text = known ? t(known, { path: String(status.problemParams?.path ?? ''), port: '{port}' }) : undefined;
    // A reason LLM Bench can say in its own words, else the error catalog's text.
    if (text !== undefined && text !== known) return <Callout tone="danger" title={text} />;
    return <ErrorCallout error={{ code: status.problems[0] ?? 'ENGINE_START_FAILED', message: status.location ?? '', ...(status.problemParams ? { params: status.problemParams } : {}) }} />;
  }
  if (check.kind === 'command') {
    return <Callout tone="success" title={t('engines.custom.check.commandOk', { path: status.location ?? '' })} />;
  }
  const required = missing.filter((m) => m.effect === 'required');
  const optional = missing.filter((m) => m.effect === 'default');
  const title = status.version ? t('engines.custom.check.ok', { version: status.version }) : t('engines.custom.check.okNoVersion');
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
