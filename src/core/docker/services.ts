import type { CoreDeps } from '../deps';
import { DockerApiProvider } from './api-provider';
import { DockerCli } from './cli';
import { resolveDockerEndpoints } from './endpoint';
import { DockerEnvironment, type DockerEnvironmentOptions } from './environment';
import { DockerHubClient } from './hub';
import { ImageService } from './images';

export interface DockerServices {
  cli: DockerCli;
  api: DockerApiProvider;
  env: DockerEnvironment;
  hub: DockerHubClient;
  images: ImageService;
}

export type DockerServicesDeps = Pick<CoreDeps, 'proc' | 'platform' | 'env' | 'endpoints' | 'paths' | 'clock' | 'fetch' | 'log'>;

const ENV_TIMINGS = [
  'statusMaxAgeMs',
  'startTimeoutMs',
  'startPollMs',
  'slowStartMs',
  'versionTimeoutMs',
  'stuckStartingMs',
  'stuckStoppingMs',
  'desktopStatusEveryMs',
  'desktopStatusTimeoutMs',
  'probeTimeoutMs',
  'restartCommandTimeoutMs',
  'restartWaitMs',
] as const;
const CONTROL_TIMINGS = ['activeEveryMs', 'idleEveryMs'] as const;

export type DockerTimings = Partial<Record<(typeof ENV_TIMINGS)[number] | (typeof CONTROL_TIMINGS)[number], number>>;

/**
 * GPUBENCH_DOCKER_TIMINGS: a JSON object of DockerEnvironment and DockerControl timings in ms (E2E
 * and mockups find a stuck fake Docker in seconds, not minutes). Anything else is ignored.
 */
export function dockerTimings(value: string | undefined): { env: Partial<DockerEnvironmentOptions>; control: DockerTimings } {
  const out: { env: Record<string, number>; control: Record<string, number> } = { env: {}, control: {} };
  let v: unknown;
  try {
    v = JSON.parse(value ?? '{}');
  } catch {
    return out;
  }
  if (!v || typeof v !== 'object') return out;
  const pick = (keys: readonly string[], into: Record<string, number>) => {
    for (const k of keys) {
      const x = (v as Record<string, unknown>)[k];
      if (typeof x === 'number' && Number.isFinite(x) && x >= 0) into[k] = x;
    }
  };
  pick(ENV_TIMINGS, out.env);
  pick(CONTROL_TIMINGS, out.control);
  return out;
}

/** Builds the Docker services from the core deps (composition root helper). */
export function createDockerServices(
  deps: DockerServicesDeps,
  envOptions: Partial<Omit<DockerEnvironmentOptions, 'cli' | 'clock' | 'platform' | 'env'>> = {},
): DockerServices {
  const cli = new DockerCli({
    proc: deps.proc,
    platform: deps.platform,
    env: deps.env,
    ...(deps.endpoints.docker ? { override: deps.endpoints.docker } : {}),
  });
  const api = new DockerApiProvider({
    resolve: () =>
      resolveDockerEndpoints({
        platform: deps.platform,
        env: deps.env,
        home: deps.paths.home,
        ...(deps.endpoints.dockerHost ? { override: deps.endpoints.dockerHost } : {}),
      }),
  });
  // wsl.exe only for the last-resort restart (`wsl --terminate docker-desktop`, after the user's click).
  const env = new DockerEnvironment({
    cli,
    clock: deps.clock,
    platform: deps.platform,
    env: deps.env,
    log: deps.log,
    proc: deps.proc,
    ...(deps.endpoints.wsl ? { wsl: deps.endpoints.wsl } : {}),
    ...envOptions,
  });
  const hub = new DockerHubClient({ fetch: deps.fetch, baseUrl: deps.endpoints.dockerHub, clock: deps.clock });
  const images = new ImageService({ api, cli, hub, log: deps.log });
  return { cli, api, env, hub, images };
}
