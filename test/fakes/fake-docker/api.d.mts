export interface FakeLayer {
  id: string;
  size: number;
  /** "Already exists" locally (no download). */
  exists?: boolean;
}

export interface FakePullOptions {
  layers?: FakeLayer[];
  /** Downloading messages per layer (default 4). */
  steps?: number;
  delayMs?: number;
  /** Stop answering at this download step (cancellation tests). */
  stallAt?: number;
  error?: 'not-found' | 'denied' | 'http-500' | 'stream-error' | 'no-space';
}

export interface FakeContainer {
  Id: string;
  Names?: string[];
  Image?: string;
  Labels?: Record<string, string>;
  State: string;
  Status?: string;
  ExitCode?: number;
  OOMKilled?: boolean;
  StartedAt?: string;
}

export interface FakeDockerApiOptions {
  socketPath?: string;
  /** ok (default) | starting (500 everywhere) | podman | hang (never answers). */
  mode?: 'ok' | 'starting' | 'podman' | 'hang';
  images?: Record<string, { Id: string; RepoTags?: string[]; RepoDigests?: string[]; Size?: number }>;
  containers?: FakeContainer[];
  volumes?: Record<string, { Name: string; Labels?: Record<string, string>; Mountpoint?: string }>;
  pull?: FakePullOptions;
  /** Fields merged into GET /info. */
  info?: Record<string, unknown>;
}

export interface FakeDockerApi {
  socketPath: string;
  requests: { method: string; path: string; query: string }[];
  state: {
    mode: string;
    images: Map<string, unknown>;
    containers: FakeContainer[];
    volumes: Map<string, unknown>;
    pull: FakePullOptions;
    info: Record<string, unknown>;
  };
  set(patch: Partial<FakeDockerApi['state']>): void;
  close(): Promise<void>;
}

export function randomSocketPath(): string;
export function startFakeDockerApi(opts?: FakeDockerApiOptions): Promise<FakeDockerApi>;
