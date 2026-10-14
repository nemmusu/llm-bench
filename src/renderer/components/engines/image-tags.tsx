import { Check, HardDrive, Trash2 } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import type { LocalImage } from '../../../contract/docker';
import { useI18n } from '../../i18n';
import { localImageFor, removalRef, useLocalImages, useRemoveImage } from '../../lib/queries-images';
import type { VllmTag } from '../../lib/queries-library';
import { ErrorCallout } from '../library/error-callout';
import { Badge } from '../ui/badge';
import { Button, IconButton } from '../ui/button';
import { ConfirmDialog } from '../ui/dialog';
import { PullButton } from './docker-card';

const PREVIEW = 6;

export interface ImageTagListProps {
  /** "vllm/vllm-openai", "lmsysorg/sglang". */
  repo: string;
  engine: 'vllm-docker' | 'sglang-docker';
  tags: readonly VllmTag[];
  /** The image chosen for this engine (Benchmark and servers use it). */
  current: string | undefined;
  /** Docker answers: local images are read, downloads possible. */
  dockerUp: boolean;
  /** Accessible name of the list. */
  label: string;
  /** "Tutte le versioni (24)". */
  allLabel: (n: number) => string;
  onUse: (image: string) => void;
  /** Badges an engine adds to a tag (vLLM: "does not support your GPU"). */
  badges?: (tag: VllmTag) => ReactNode;
}

/**
 * The versions of a Docker engine, each with one thing to do: not on the PC → "Scarica"; on the PC →
 * "Usa questa" (unless it is the one in use) and its removal (`docker image rm`, after a confirmation
 * with its size; not while a server or a test uses it).
 */
export function ImageTagList({ repo, engine, tags, current, dockerUp, label, allLabel, onUse, badges }: ImageTagListProps) {
  const { t, bytes, date } = useI18n();
  const local = useLocalImages(repo, dockerUp);
  const remove = useRemoveImage();
  const [all, setAll] = useState(false);
  const [confirm, setConfirm] = useState<{ ref: string; image: LocalImage }>();
  // Versions on the PC that Docker Hub no longer lists (or beyond the pages read): still usable and removable.
  const others: VllmTag[] = (local.data ?? []).filter((i) => i.tags.length && !tags.some((tg) => localImageFor(tg, [i]))).map((i) => ({ name: i.tags[0] as string }));
  // The version in use is always listed ("In uso"), even when Docker Hub no longer has it.
  const currentTag = current?.startsWith(`${repo}:`) ? current.slice(repo.length + 1) : undefined;
  if (currentTag && ![...tags, ...others].some((tg) => tg.name === currentTag)) others.push({ name: currentTag });
  // The one in use, then the ones on the PC: what can be used or removed right away.
  const rank = (tg: VllmTag) => (tg.name === currentTag ? 2 : localImageFor(tg, local.data) ? 1 : 0);
  const sorted = [...tags, ...others].sort((a, b) => rank(b) - rank(a));
  const shown = all ? sorted : sorted.slice(0, PREVIEW);
  return (
    <>
      <ul className="flex flex-col divide-y divide-border rounded-lg border border-border" aria-label={label}>
        {shown.map((tag) => {
          const image = `${repo}:${tag.name}`;
          const mine = localImageFor(tag, local.data);
          const inUse = current === image;
          return (
            <li key={tag.name} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2.5" data-local={mine ? 'true' : undefined}>
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-sm font-semibold text-fg">{tag.name}</span>
                  {tag.recommended && (
                    <Badge size="sm" tone="accent">
                      {t('common.recommended')}
                    </Badge>
                  )}
                  {badges?.(tag)}
                  {inUse && (
                    <Badge size="sm" tone="success">
                      <Check aria-hidden />
                      {t('engines.llama.inUse')}
                    </Badge>
                  )}
                  {mine && (
                    <Badge size="sm" tone="outline">
                      <HardDrive aria-hidden />
                      {t('engines.images.onPc', { size: bytes(mine.sizeBytes) })}
                    </Badge>
                  )}
                </span>
                <span className="text-xs text-fg-3 tabular-nums">
                  {[tag.cuda ? `CUDA ${tag.cuda}` : undefined, !mine && tag.sizeBytes ? bytes(tag.sizeBytes) : undefined, tag.lastUpdated ? date(tag.lastUpdated) : undefined].filter(Boolean).join(' · ')}
                </span>
              </span>
              {mine ? (
                <span className="flex items-center gap-1">
                  {!inUse && (
                    <Button size="sm" onClick={() => onUse(image)}>
                      {t('engines.vllm.use')}
                    </Button>
                  )}
                  {mine.running ? (
                    // Said, not hidden: why it cannot go now.
                    <IconButton label={t('engines.images.removeRunning')} icon={<Trash2 />} size="sm" aria-disabled className="cursor-not-allowed opacity-50" onClick={() => undefined} />
                  ) : (
                    <IconButton label={t('engines.images.remove', { image })} icon={<Trash2 />} size="sm" onClick={() => setConfirm({ ref: removalRef(repo, tag.name, mine), image: mine })} />
                  )}
                </span>
              ) : (
                <PullButton engine={engine} image={image} label={t('engines.vllm.pull')} disabled={!dockerUp} />
              )}
            </li>
          );
        })}
      </ul>
      {sorted.length > PREVIEW && (
        <Button variant="link" className="self-start" onClick={() => setAll((a) => !a)}>
          {all ? t('models.curated.less') : allLabel(sorted.length)}
        </Button>
      )}
      {remove.isError && <ErrorCallout error={remove.error} />}
      <ConfirmDialog
        open={confirm !== undefined}
        onOpenChange={(o) => !o && setConfirm(undefined)}
        title={t('engines.images.removeTitle', { image: confirm?.ref ?? '' })}
        description={t('engines.images.removeBody', { size: bytes(confirm?.image.sizeBytes ?? 0), command: `docker image rm ${confirm?.ref ?? ''}` })}
        confirmLabel={t('engines.images.removeConfirm')}
        cancelLabel={t('common.cancel')}
        onConfirm={() => remove.mutate((confirm as { ref: string }).ref)}
      />
    </>
  );
}
