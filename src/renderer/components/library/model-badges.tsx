import type { FitRequest } from '../../../contract/api';
import type { FitEstimate } from '../../../contract/models';
import { useI18n } from '../../i18n';
import { useFit, useMainGpu, useTried } from '../../lib/queries-library';
import { FitBadge } from '../ui/fit-badge';
import { Skeleton } from '../ui/skeleton';
import { TriedHereBadge } from '../ui/tried-badge';
import { bestRunHere } from './helpers';

/** "Stima: 6,8 GB su 30,4 GB disponibili" for the fit tooltip. */
export function useFitDetail(): (fit: FitEstimate) => string {
  const { t, bytes } = useI18n();
  return (fit) => t('fit.estimate', { need: bytes(fit.needMiB * 1024 * 1024), available: bytes(fit.availableMiB * 1024 * 1024) });
}

/** VRAM verdict for a local model or a hub file, computed by the core (POST /api/models/fit). */
export function FitFor({ req }: { req: FitRequest }) {
  const fit = useFit(req);
  const detail = useFitDetail();
  if (fit.isPending) return <Skeleton className="h-5 w-28 rounded-full" />;
  if (!fit.data) return null;
  return <FitBadge level={fit.data.level} detail={detail(fit.data)} size="sm" />;
}

/**
 * "Provato su questa GPU · 142 tok/s" when a completed run of this model exists for this GPU; "Provato:
 * usava la RAM condivisa" when the only ones spilled to shared memory (their speed does not count).
 */
export function TriedFor({ weakKey, sha256 }: { weakKey: string; sha256?: string | undefined }) {
  const tried = useTried(weakKey, sha256);
  const gpu = useMainGpu();
  const best = bestRunHere(tried.data, gpu);
  if (!best) return null;
  return <TriedHereBadge tried={best} short={false} size="sm" />;
}
