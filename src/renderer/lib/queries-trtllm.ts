/**
 * Data hooks of TensorRT-LLM's card. Its statuses are GET /api/engines ('trtllm-docker': the image in use,
 * `installed` when it is on the PC; 'trtllm-native': the version, its problems); the versions on the PC
 * are queries-images.ts useLocalImages(TRTLLM_REPO); besides those:
 *
 *   GET    /api/engines/trtllm/tags?refresh=1  -> TrtllmTag[] (NGC's releases, newest first, the recommended one marked)
 *   POST   /api/engines/:kind/install          ({ image? }) -> { ok: true }; progress as 'engine.install' events
 *                                                (trtllm-docker: keyed `pull:<image>`; trtllm-native: kind 'trtllm-native')
 *   POST   /api/docker/images/remove           ({ image }) -> { ok: true }: a version on the PC (refused while a container uses it)
 *   DELETE /api/engines/trtllm-native/install  -> { ok: true }: LLM Bench's own environment
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useApi } from './api-context';
import { libKeys } from './queries-library';

/** NVIDIA's release image on NGC. */
export const TRTLLM_REPO = 'nvcr.io/nvidia/tensorrt-llm/release';

/** A release on NGC. */
export interface TrtllmTag {
  name: string;
  recommended: boolean;
  /** A release candidate (X.Y.ZrcN): newer, less tested than a stable X.Y.Z. */
  prerelease: boolean;
  /** Download size, for the newest few and the recommended one. */
  sizeBytes?: number;
  digest?: string;
}

/** Under the engines' key: an install, a pull, an update or a Docker change that ends reads it again (handleLibraryEvent). */
export const TRTLLM_TAGS_KEY = [...libKeys.engines, 'trtllm', 'tags'] as const;

export function useTrtllmTags(enabled: boolean) {
  const api = useApi();
  return useQuery({ queryKey: TRTLLM_TAGS_KEY, queryFn: () => api.get<TrtllmTag[]>('/api/engines/trtllm/tags'), enabled, staleTime: 10 * 60_000, retry: false });
}

/** Every view of the engines is read again (statuses, versions on the PC, the system check). */
function refresh(qc: ReturnType<typeof useQueryClient>): void {
  for (const k of [libKeys.engines, libKeys.docker, libKeys.check]) void qc.invalidateQueries({ queryKey: k });
}

/** A Docker version removed by its image, the one in use too (the same removal as every Docker engine's versions). */
export function useRemoveTrtllmImage() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (image: string) => api.post<{ ok: true }>('/api/docker/images/remove', { image }),
    onSettled: () => refresh(qc),
  });
}

/** LLM Bench's own environment removed (never one of the user's). */
export function useRemoveTrtllmNative() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.del<{ ok: true }>('/api/engines/trtllm-native/install'),
    onSettled: () => refresh(qc),
  });
}
