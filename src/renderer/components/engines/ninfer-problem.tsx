import type { EngineStatus } from '../../../contract/engines';
import { useI18n } from '../../i18n';
import { ErrorCallout } from '../library/error-callout';
import { Callout } from '../ui/callout';

const KNOWN_PROBLEMS = ['ninfer_not_found', 'distro_missing', 'wsl_missing'] as const;
type KnownProblem = (typeof KNOWN_PROBLEMS)[number] | 'ninfer_not_built';

/** The checkout is there (its commit is known) but its ninfer-serve does not answer: not built yet, or its build is broken. */
export function ninferNotBuilt(status: EngineStatus | undefined): boolean {
  return status !== undefined && !status.installed && status.problemParams?.reason === 'ninfer_not_found' && status.version !== undefined;
}

/**
 * Why NInfer (or a variant of it) cannot be used, in its own words (a wrong path, a checkout not built
 * yet, a distro that is gone), else the error catalog's.
 */
export function NinferProblem({ status, fallback }: { status: EngineStatus; fallback: string }) {
  const { t } = useI18n();
  const reason = status.problemParams?.reason;
  if (typeof reason === 'string' && (KNOWN_PROBLEMS as readonly string[]).includes(reason)) {
    // The checkout is there (its commit is known) but nothing is built yet: say so, the build compiles it in place.
    const r = ninferNotBuilt(status) ? 'ninfer_not_built' : (reason as KnownProblem);
    const params = { path: String(status.problemParams?.path ?? status.location ?? fallback), distro: String(status.problemParams?.distro ?? ''), commit: status.version ?? '' };
    return (
      <Callout tone="danger" title={t(`ninfer.problems.${r}.title`, params)}>
        {t(`ninfer.problems.${r}.body`, params)}
      </Callout>
    );
  }
  return <ErrorCallout error={{ code: status.problems[0] ?? 'ENGINE_NOT_INSTALLED', message: status.location ?? fallback, ...(status.problemParams ? { params: status.problemParams } : {}) }} />;
}
