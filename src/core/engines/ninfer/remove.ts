/**
 * Removing one of NInfer's builds from the Engines page, the way everything LLM Bench adds can be removed
 * where it was added: a build LLM Bench made (its record of the commit is in the folder) is deleted with
 * its checkout, after the card showed the folder, its size and the command; a build of the user's own is
 * only forgotten (its files stay); one built by hand in NInfer-all's usual folder would be found again
 * there, so the card says to delete that folder by hand.
 */
import { NINFER_ALL_DIR } from '../../../contract/custom-engines';
import { AppError } from '../../../contract/errors';
import type { NinferBuildInfo, NinferRemovePlan } from '../../../contract/ninfer';
import type { DistroRun } from './wsl';

/** "~/x" → "$HOME/x" inside the shell, then the folder's size in KiB (du -sk), after a marker. */
export const SIZE_SCRIPT = 'd="$1"; case "$d" in "~/"*) d="$HOME/${d#"~/"}";; esac; echo "##gpubench-size $(du -sk -- "$d" 2>/dev/null | cut -f1)"';
/** The same folder, deleted; the marker says it went. */
export const REMOVE_SCRIPT = 'd="$1"; case "$d" in "~/"*) d="$HOME/${d#"~/"}";; esac; rm -rf -- "$d" && echo "##gpubench-removed"';

/** A folder LLM Bench may delete: inside a home folder, one level down at least, nothing like "..". */
export function deletableDir(dir: string): boolean {
  return /^(?:~|\/home\/[^/]+|\/root)\/[^/]/.test(dir) && !dir.split('/').some((p) => p === '..' || p === '.');
}

/** What removing a build does (the plan the card shows before asking). */
export function removeModeOf(info: Pick<NinferBuildInfo, 'build' | 'built' | 'dir'>): NinferRemovePlan['mode'] {
  if (info.built !== undefined && deletableDir(info.dir)) return 'delete';
  // Built by hand in NInfer-all's usual folder: LLM Bench adopts what works there, a "forget" would not last.
  const fromHome = info.dir.replace(/^(?:\/home\/[^/]+|\/root)(?=\/)/, '~');
  return info.build === 'all' && fromHome === NINFER_ALL_DIR ? 'manual' : 'forget';
}

/** The command the card shows ("rm -rf ~/ninfer-all", inside its distro). */
export function removeCommand(dir: string, distro: string | undefined): string {
  return distro ? `wsl -d ${distro} -- rm -rf ${dir}` : `rm -rf ${dir}`;
}

/** The folder's size, undefined when `du` does not say. */
export async function folderBytes(run: DistroRun, dir: string): Promise<number | undefined> {
  const out = await run('/bin/sh', ['-c', SIZE_SCRIPT, 'sh', dir], { timeoutMs: 60_000 });
  const kib = Number(/##gpubench-size (\d+)/.exec(out.stdout)?.[1]);
  return Number.isFinite(kib) && kib > 0 ? kib * 1024 : undefined;
}

/** Deletes the folder (the marker proves it went), else INTERNAL with what the shell said. */
export async function deleteFolder(run: DistroRun, dir: string): Promise<void> {
  if (!deletableDir(dir)) throw new AppError('VALIDATION', `Not a folder LLM Bench deletes: ${dir}`, { params: { reason: 'not-deletable', dir } });
  const out = await run('/bin/sh', ['-c', REMOVE_SCRIPT, 'sh', dir], { timeoutMs: 5 * 60_000 });
  if (!out.stdout.includes('##gpubench-removed')) {
    throw new AppError('INTERNAL', `Could not delete ${dir}`, { params: { dir }, detail: `${out.stderr}\n${out.stdout}`.trim().slice(-2000) });
  }
}
