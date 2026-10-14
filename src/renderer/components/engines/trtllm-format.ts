/** TensorRT-LLM's card in words: its versions, each way's state, the card's, which way to show first. */
import type { DockerState, LocalImage } from '../../../contract/docker';
import type { EngineConfig, EngineStatus } from '../../../contract/engines';
import { localImageFor } from '../../lib/queries-images';
import type { TrtllmTag } from '../../lib/queries-trtllm';
import type { StatusDotProps } from '../ui/status-dot';

export type TrtllmMode = 'docker' | 'native';

/** Where a way stands: ready to run, to install, waiting for Docker, something missing for the native one, not on this system. */
export type ModeState = 'ready' | 'notInstalled' | 'needsDocker' | 'needsSetup' | 'unsupported';

/** A Docker version as the card lists it. */
export interface TrtllmVersion {
  tag: string;
  image: string;
  recommended: boolean;
  prerelease: boolean;
  /** Download size (NGC), when known. */
  sizeBytes?: number;
  /** On this PC: its size when Docker says it, whether a container runs it now. */
  local?: { sizeBytes?: number; running: boolean };
}

/**
 * NGC's releases with what is on the PC, then the versions on the PC NGC no longer lists. Without the list
 * of local images (Docker off, an older core) the engine status still says whether the image in use is there.
 */
export function trtllmVersions(repo: string, tags: readonly TrtllmTag[], images: readonly LocalImage[] | undefined, status: EngineStatus | undefined): TrtllmVersion[] {
  const statusLocal = (image: string) => (status?.installed && status.location === image ? { running: false } : undefined);
  const rows = tags.map((t): TrtllmVersion => {
    const image = `${repo}:${t.name}`;
    // By its name, else by its digest (the containerd image store names images by digest).
    const mine = localImageFor(t, images);
    const local = mine ? { sizeBytes: mine.sizeBytes, running: mine.running } : statusLocal(image);
    return { tag: t.name, image, recommended: t.recommended, prerelease: t.prerelease, ...(t.sizeBytes ? { sizeBytes: t.sizeBytes } : {}), ...(local ? { local } : {}) };
  });
  const others = (images ?? [])
    .filter((i) => i.tags.length > 0 && !tags.some((t) => localImageFor(t, [i])))
    .map((i): TrtllmVersion => {
      const tag = i.tags[0] as string;
      return { tag, image: `${repo}:${tag}`, recommended: false, prerelease: false, local: { sizeBytes: i.sizeBytes, running: i.running } };
    });
  // The image in use, on the PC, that neither list names (a tag of the user's own).
  const named = [...rows, ...others].some((v) => v.image === status?.location);
  const own = !named && status?.installed && status.location ? [{ tag: status.version ?? status.location, image: status.location, recommended: false, prerelease: false, local: { running: false } }] : [];
  return [...rows, ...others, ...own];
}

/** Docker: ready with a version on the PC and Docker answering; otherwise Docker first, then the download. */
export function dockerModeState(versions: readonly TrtllmVersion[], state: DockerState | undefined): ModeState {
  if (state !== 'running') return 'needsDocker';
  return versions.some((v) => v.local) ? 'ready' : 'notInstalled';
}

/** Problems of the native status that the user fixes in WSL (a command each), not with LLM Bench's install. */
const SETUP_REASONS = new Set(['wsl_missing', 'distro_missing']);

/** What the native way lacks before the install: WSL itself, or a Linux distro in it. */
export function nativeNeed(status: EngineStatus | undefined): 'wsl' | 'distro' | undefined {
  const reason = status?.problems[0] === 'ENGINE_NOT_INSTALLED' ? status.problemParams?.reason : undefined;
  return typeof reason === 'string' && SETUP_REASONS.has(reason) ? (reason === 'wsl_missing' ? 'wsl' : 'distro') : undefined;
}

/** Native: not where it cannot run, ready, WSL to set up first, installed but missing something (a system library), or not installed. */
export function nativeModeState(status: EngineStatus | undefined): ModeState {
  if (!status || status.supported === false) return 'unsupported';
  if (status.available) return 'ready';
  if (nativeNeed(status) || status.installed) return 'needsSetup';
  return 'notInstalled';
}

/** The card's status: ready when either way is; else what holds back the one that is on the PC; else not installed. */
export function trtllmStatus(dockerLocal: boolean, nativeInstalled: boolean, docker: ModeState, native: ModeState): { tone: StatusDotProps['tone']; key: 'ready' | 'notInstalled' | 'needsDocker' | 'needsSetup' } {
  if (docker === 'ready' || native === 'ready') return { tone: 'success', key: 'ready' };
  if (dockerLocal && docker === 'needsDocker') return { tone: 'warning', key: 'needsDocker' };
  if (nativeInstalled && native === 'needsSetup') return { tone: 'warning', key: 'needsSetup' };
  return { tone: 'neutral', key: 'notInstalled' };
}

/** The way shown first: the one the Benchmark uses, else the only one ready, else Docker (the simplest). */
export function initialMode(last: EngineConfig | undefined, docker: ModeState, native: ModeState): TrtllmMode {
  if (last?.kind === 'trtllm-native' && last.customEngineId === undefined) return 'native';
  if (last?.kind === 'trtllm-docker' && last.customEngineId === undefined) return 'docker';
  return native === 'ready' && docker !== 'ready' ? 'native' : 'docker';
}

/** The image the Benchmark runs for 'trtllm-docker': the one chosen, else the engine's default (its status location). */
export function imageInUse(last: EngineConfig | undefined, defaultImage: string | undefined): string | undefined {
  if (last?.kind === 'trtllm-docker' && last.customEngineId === undefined && last.image) return last.image;
  return defaultImage;
}

/** The version a first download offers: the recommended one, else the newest stable, else the newest. */
export function firstVersion(versions: readonly TrtllmVersion[]): TrtllmVersion | undefined {
  return versions.find((v) => v.recommended) ?? versions.find((v) => !v.prerelease) ?? versions[0];
}

/** The versions on the PC first (what can be used or removed right away), then the others in NGC's order. */
export function sortVersions(versions: readonly TrtllmVersion[]): TrtllmVersion[] {
  return [...versions].sort((a, b) => Number(!!b.local) - Number(!!a.local));
}
