/** LLM Bench's Python environments of vLLM and SGLang on Linux: what is there, and their removal (contract/native-envs.ts). */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { nativeEnvPath, type NativeEnvKind, type NativeEnvPlan } from '../../contract/native-envs';
import { useApi } from './api-context';
import { engineKeys } from './queries-engines';
import { libKeys } from './queries-library';

/** Under the engines' key: an install or an update that ends reads it again with the engines. */
export const nativeEnvKey = (kind: NativeEnvKind) => [...libKeys.engines, 'environment', kind] as const;

/** GET /api/engines/:kind/environment: the folder, its size, the user's own environment, busy (asked again every 5 s while busy). */
export function useNativeEnv(kind: NativeEnvKind) {
  const api = useApi();
  return useQuery({
    queryKey: nativeEnvKey(kind),
    queryFn: () => api.get<NativeEnvPlan>(nativeEnvPath(kind)),
    staleTime: 30_000,
    retry: false,
    refetchInterval: (q) => (q.state.data?.busy ? 5_000 : false),
  });
}

/** DELETE /api/engines/:kind/environment, then the engines, the system check and the update check read again. */
export function useRemoveNativeEnv(kind: NativeEnvKind) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.del<{ ok: true }>(nativeEnvPath(kind)),
    onSettled: () => {
      for (const k of [libKeys.engines, libKeys.check, engineKeys.update(kind)]) void qc.invalidateQueries({ queryKey: k });
    },
  });
}
