import type { GgufSpec, SafetensorsSpec } from './model-files.mjs';

export interface FakeFileSpec {
  /** Path inside the repo, "/"-separated. */
  path: string;
  content?: string | Uint8Array;
  gguf?: GgufSpec;
  safetensors?: SafetensorsSpec;
  /** Size of seeded filler content when no content/gguf/safetensors is given (default 1 KiB). */
  size?: number;
  seed?: number;
  /** Served via a signed CDN redirect (default: weights extensions or > 10 KiB). */
  lfs?: boolean;
}

export interface FakeRepoSpec {
  id: string;
  /** Commit sha (default sha1 of the id). */
  sha?: string;
  private?: boolean;
  gated?: false | 'auto' | 'manual';
  /** For gated repos: whether the test token has accepted the license. */
  accepted?: boolean;
  downloads?: number;
  likes?: number;
  trendingScore?: number;
  lastModified?: string;
  /** Sort key of "newest" (default lastModified). */
  createdAt?: string;
  /** Parameter count for `num_parameters` filters (default safetensorsTotal, else the size in the id). */
  numParameters?: number;
  pipelineTag?: string;
  license?: string;
  baseModel?: string | string[];
  safetensorsTotal?: number;
  tags?: string[];
  readme?: string;
  files: FakeFileSpec[];
}

export interface FakeHubBehavior {
  /** Bytes per second for file bodies (0 = unthrottled). */
  throttleBytesPerSec: number;
  /** Close the connection after this many body bytes… */
  dropAfterBytes: number;
  /** …for this many responses. */
  dropTimes: number;
  /** Lifetime of signed CDN URLs. */
  tokenTtlMs: number;
  /** Answer 200 with the full body even when Range is requested. */
  ignoreRange: boolean;
  /** The next N hub requests get 429. */
  rateLimitNext: number;
  /** The next `times` hub requests whose path contains `match` (or CDN requests when match = "cdn") get `status`. */
  failNext?: { status: number; times: number; match?: string };
  /** "repo/path" entries served with their last byte flipped. */
  corrupt: string[];
  /** Page size of tree listings (0 = no paging); pages are linked with `Link: rel="next"`. */
  treePageSize: number;
}

export interface FakeHubOptions {
  repos?: FakeRepoSpec[];
  /** Accepted bearer tokens (default ["hf_test_token"]). */
  tokens?: string[];
  behavior?: Partial<FakeHubBehavior>;
  port?: number;
  cdnPort?: number;
}

export interface FakeRequest {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  origin: 'hub' | 'cdn';
}

export interface FakeHub {
  /** Hub base URL (use as CoreEndpoints.huggingface). */
  url: string;
  /** Signed-URL server: another origin, like HF's CDN. */
  cdnUrl: string;
  behavior: FakeHubBehavior;
  requests: FakeRequest[];
  close(): Promise<void>;
  expireSignedUrls(): void;
  file(repo: string, path: string): { bytes: Buffer; size: number; sha256: string; lfs: boolean };
  repo(repo: string): { id: string; sha: string; files: string[] };
  addRepo(spec: FakeRepoSpec): void;
  setAccepted(repo: string, accepted: boolean): void;
}

export declare function demoRepos(): FakeRepoSpec[];
export declare function startFakeHub(opts?: FakeHubOptions): Promise<FakeHub>;
