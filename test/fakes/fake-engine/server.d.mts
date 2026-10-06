export interface FakeProfile {
  loadMsCold?: number;
  loadMsWarm?: number;
  prefillTps?: number;
  decodeTps?: number;
  tokensPerChunk?: number;
  timeScale?: number;
  oomAtLoad?: boolean;
  noKernelImage?: boolean;
  crashAfterTokens?: number;
  stallAfterTokens?: number;
  httpErrorRate?: number;
  badFlag?: string;
  eosAfter?: number;
  vramMiB?: number;
  nLayers?: number;
  seed?: number;
  busy?: { utilPct: number; powerW: number; tempC?: number };
}

export interface FakeEngineOptions {
  flavor?: 'llamacpp' | 'vllm';
  host?: string;
  port?: number;
  model?: string;
  alias?: string;
  ctx?: number;
  np?: number;
  flashAttn?: string;
  profile?: FakeProfile;
  log?: (line: string) => void;
  stateFile?: string;
  coldMarker?: string;
  requireModelFile?: boolean;
  watchdog?: boolean;
  onFatal?: (code: number) => void;
}

export interface FakeEngine {
  readonly port: number;
  readonly url: string;
  readonly loaded: Promise<void>;
  readonly totalTokens: number;
  close(): Promise<void>;
}

export function readProfile(env?: Record<string, string | undefined>): FakeProfile;
export function tokenize(text: string, addSpecial?: boolean): number[];
export function piece(id: number): string;
export function detokenize(ids: number[]): string;
export function startFakeEngine(opts?: FakeEngineOptions): Promise<FakeEngine>;
