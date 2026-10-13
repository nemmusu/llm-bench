/**
 * "Aggiorna" on an engine's card: is there a newer version, how big, which commands, then the update
 * with its progress ('engine.install' events of kind `update:<target>`).
 *
 * Targets: 'vllm-docker', 'sglang-docker' (the image in use, against the newest release tag of the
 * same kind, or the same tag's newer digest), 'vllm-native', 'sglang-native' (the managed uv
 * environment, against PyPI) and `custom:<id>` for a custom engine: its Docker image (a newer tag
 * on Docker Hub, else the same tag pulled again) or a llama.cpp fork built from a git checkout
 * (`git pull --ff-only`, then `cmake --build`); 'ninfer-native' / 'ninfer-wsl', NInfer's git checkout
 * (on Linux, or inside the chosen WSL distro), the same way, its previous build kept aside until the
 * new one is built; a NInfer variant (`custom:<id>`, base 'ninfer') its own checkout the same way. Anything
 * else is updated with its own tools.
 */
import { z } from 'zod';
import { ninferArtifactUpgradeSchema } from './ninfer';

/** How an engine is updated from the app. */
export const ENGINE_UPDATE_METHODS = ['docker-tag', 'docker-pull', 'uv', 'git', 'none'] as const;
export type EngineUpdateMethod = (typeof ENGINE_UPDATE_METHODS)[number];

/**
 * available: a newer version to install; current: up to date; unknown: cannot tell (an image outside
 * Docker Hub: it can be pulled again); blocked: not now (`reason`); none: not from the app.
 */
export const ENGINE_UPDATE_STATES = ['available', 'current', 'unknown', 'blocked', 'none'] as const;
export type EngineUpdateState = (typeof ENGINE_UPDATE_STATES)[number];

export const ENGINE_UPDATE_REASONS = [
  // Nothing installed to update (the card offers the install).
  'not-installed',
  'no-docker',
  // git: uncommitted changes, no branch, no upstream branch, local commits the upstream lacks, fetch failed.
  'dirty',
  'detached',
  'no-upstream',
  'diverged',
  'fetch-failed',
  'git-missing',
  'cmake-missing',
  // A Python environment of the user's own (vllmPath / sglangPath): theirs to update.
  'own-environment',
  // An image fixed by its digest never changes.
  'pinned',
  // A benchmark or a server is using the GPU (an update would change the engine under it).
  'busy',
  // Updated with its own tools (a program of the user's own, a build outside git…).
  'tools',
] as const;
export type EngineUpdateReason = (typeof ENGINE_UPDATE_REASONS)[number];

export const engineUpdateCheckSchema = z.object({
  /** 'vllm-docker' | 'sglang-docker' | 'vllm-native' | 'sglang-native' | 'custom:<id>'. */
  target: z.string(),
  method: z.enum(ENGINE_UPDATE_METHODS),
  state: z.enum(ENGINE_UPDATE_STATES),
  reason: z.enum(ENGINE_UPDATE_REASONS).optional(),
  /** What is installed: a tag, a version, a short commit. */
  current: z.string().optional(),
  /** What the update installs (same as `current` for a newer image of the same tag). */
  latest: z.string().optional(),
  /** Download size of the new image or package, when known. */
  sizeBytes: z.number().nonnegative().optional(),
  /** git: new commits upstream. */
  commits: z.number().int().nonnegative().optional(),
  /** git: files with uncommitted changes (reason 'dirty'). */
  changed: z.number().int().nonnegative().optional(),
  /** git: the branch checked out. */
  branch: z.string().optional(),
  /** Docker: the image the update pulls. */
  image: z.string().optional(),
  /** git: the checkout and the CMake build folder. */
  repo: z.string().optional(),
  buildDir: z.string().optional(),
  /** The exact commands the update runs, shown before it is confirmed. */
  commands: z.array(z.array(z.string())),
  /** Why a check could not finish (reason 'fetch-failed'): the tool's last lines. */
  detail: z.string().optional(),
  /** When the remote was last asked (ISO). */
  checkedAt: z.string(),
  /** git: the new commits, newest first (up to 20): short hash and title. */
  log: z.array(z.object({ sha: z.string(), title: z.string() })).optional(),
  /** What puts the previous build back if the rebuild fails (shown with the commands). */
  restore: z.array(z.array(z.string())).optional(),
  /** Where the commands run when it is not this system (NInfer: the WSL distro). */
  distro: z.string().optional(),
  /** NInfer: the container version this build reads, and the library artifacts older than it (NInfer's upgrade tool). */
  ninfer: z.object({ containerVersion: z.number().int(), artifacts: z.array(ninferArtifactUpgradeSchema) }).optional(),
});
export type EngineUpdateCheck = z.infer<typeof engineUpdateCheckSchema>;

/** Built-in engines with an update check. */
export const UPDATABLE_KINDS = ['vllm-docker', 'sglang-docker', 'vllm-native', 'sglang-native', 'ninfer-native', 'ninfer-wsl'] as const;
export type UpdatableKind = (typeof UPDATABLE_KINDS)[number];

export const customUpdateTarget = (id: string): string => `custom:${id}`;

/** The 'engine.install' kind of an update's progress events. */
export const updateEventKind = (target: string): string => `update:${target}`;
