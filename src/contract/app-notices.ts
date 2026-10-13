import { z } from 'zod';

/**
 * One-time notices of the app itself: the Electron main process writes them to
 * <dataDir>/app-notices.json before the core starts; the window shows each one once and dismisses it.
 *
 *   GET    /api/app/notices       -> AppNotice[]
 *   DELETE /api/app/notices/:id   -> { ok: true }
 *
 *  - 'data-moved': the data of GPU Bench (the app's name before 0.4.0) is now LLM Bench's. 'moved':
 *    its folder was renamed; 'copied': it could not be (GPU Bench was open), so settings, results and
 *    secrets were copied and the old folder left as it was. `enginesIn`: the installed engines stayed
 *    there (too large to copy).
 *  - 'secret-unreadable': a saved secret could not be decrypted (on Linux the keyring entry follows
 *    the app's name) and was removed: the Hugging Face token has to be typed again, the key of the
 *    network servers is made anew. `renamed`: it happened at the first start after the rename.
 */
export const APP_NOTICES_FILE = 'app-notices.json';

export const appNoticeSchema = z.discriminatedUnion('kind', [
  z.object({
    id: z.string(),
    kind: z.literal('data-moved'),
    mode: z.enum(['moved', 'copied']),
    /** The GPU Bench folder the data came from. */
    from: z.string(),
    enginesIn: z.string().optional(),
  }),
  z.object({
    id: z.string(),
    kind: z.literal('secret-unreadable'),
    secret: z.enum(['hf-token', 'server-api-key']),
    renamed: z.boolean(),
  }),
]);
export type AppNotice = z.infer<typeof appNoticeSchema>;

/** The notices in a file's content: anything that is not a valid notice is dropped, never the rest. */
export function parseAppNotices(raw: unknown): AppNotice[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((n) => {
    const parsed = appNoticeSchema.safeParse(n);
    return parsed.success ? [parsed.data] : [];
  });
}

/** `list` with `added`: a notice replaces an older one with the same id. */
export function withAppNotices(list: readonly AppNotice[], added: readonly AppNotice[]): AppNotice[] {
  const ids = new Set(added.map((n) => n.id));
  return [...list.filter((n) => !ids.has(n.id)), ...added];
}
