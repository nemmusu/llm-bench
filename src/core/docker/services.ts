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
  const env = new DockerEnvironment({ cli, clock: deps.clock, platform: deps.platform, env: deps.env, log: deps.log, ...envOptions });
  const hub = new DockerHubClient({ fetch: deps.fetch, baseUrl: deps.endpoints.dockerHub, clock: deps.clock });
  const images = new ImageService({ api, cli, hub, log: deps.log });
  return { cli, api, env, hub, images };
}
