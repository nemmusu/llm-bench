export interface FakeGithubOptions {
  releases?: unknown[];
  rateLimited?: boolean;
  layout?: 'flat' | 'nested';
  evil?: 'zip-slip' | 'absolute' | 'symlink-out';
  wrongDigest?: boolean;
  noDigest?: boolean;
  downloadStatus?: number;
  noServerBinary?: boolean;
}

export interface FakeGithub {
  url: string;
  port: number;
  requests: { method: string; url: string; headers: Record<string, string | string[] | undefined> }[];
  set(patch: Partial<FakeGithubOptions>): void;
  close(): Promise<void>;
}

export function buildAsset(name: string, opts?: FakeGithubOptions): Buffer;
export function startFakeGithub(opts?: FakeGithubOptions): Promise<FakeGithub>;
