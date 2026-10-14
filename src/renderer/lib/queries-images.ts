import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { LocalImage } from '../../contract/docker';
import type { HubTag } from '../../contract/views';
import { useApi } from './api-context';

/** Every repository's local images live under this key: a pull or a removal reads them all again. */
export const IMAGES_KEY = ['lib', 'docker', 'images'] as const;

/** GET /api/docker/images?repo=…: the images of one repository on this Docker (only asked while Docker runs). */
export function useLocalImages(repo: string, enabled: boolean) {
  const api = useApi();
  return useQuery({
    queryKey: [...IMAGES_KEY, repo],
    queryFn: () => api.get<LocalImage[]>(`/api/docker/images?repo=${encodeURIComponent(repo)}`),
    enabled,
    staleTime: 30_000,
    retry: false,
  });
}

/**
 * The local image a Docker Hub tag is: same tag name first, else one of the tag's digests (its
 * multi-platform index or a platform's manifest) among the image's digests or as its id — the
 * containerd image store (Docker 29) names an image by its index digest.
 */
export function localImageFor(tag: Pick<HubTag, 'name' | 'digest' | 'digests'>, images: readonly LocalImage[] | undefined): LocalImage | undefined {
  if (!images?.length) return undefined;
  const byName = images.find((i) => i.tags.includes(tag.name));
  if (byName) return byName;
  const digests = new Set([...(tag.digests ?? []), ...(tag.digest ? [tag.digest] : [])]);
  return digests.size ? images.find((i) => digests.has(i.id) || i.digests.some((d) => digests.has(d))) : undefined;
}

/** What to name in `docker image rm`: the tag when the image has it (other tags of it stay), else its id. */
export function removalRef(repo: string, tag: string, image: LocalImage): string {
  return image.tags.includes(tag) ? `${repo}:${tag}` : image.id;
}

/** POST /api/docker/images/remove, then every repository's list read again. */
export function useRemoveImage() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (image: string) => api.post<{ ok: true }>('/api/docker/images/remove', { image }),
    onSettled: () => qc.invalidateQueries({ queryKey: IMAGES_KEY }),
  });
}
