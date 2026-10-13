import type { ApiFlavor, EngineConfig, EngineStatus, LaunchParams } from '../../../contract/engines';
import { AppError, toAppErrorData } from '../../../contract/errors';
import type { EngineIdentity } from '../../../contract/results';
import type { Clock, ExitInfo, LogLine } from '../../deps';
import type { ClientFactory } from '../instance';
import type { EngineAdapter, EngineCaps, EngineInstance, LaunchPlan, ModelTarget } from '../types';
import { ignore, timeoutSignal } from '../util';

export interface ExternalOptions {
  fetch: typeof globalThis.fetch;
  clock: Clock;
  createClient: ClientFactory;
  /** Per-request budget for probes (headers + body). */
  probeTimeoutMs?: number;
}

export interface EndpointProbe {
  flavor: ApiFlavor;
  version?: string;
  models: string[];
}

const FLAVOR_NAMES: Record<ApiFlavor, string> = {
  llamacpp: 'llama.cpp',
  vllm: 'vLLM',
  sglang: 'SGLang',
  openai: 'OpenAI-compatible',
  'openai-chat': 'OpenAI-compatible (chat)',
};

interface Endpoint {
  baseUrl: string;
  apiKey?: string;
  flavor: ApiFlavor;
}

interface Fetched {
  status: number;
  ok: boolean;
  /** Parsed JSON body, undefined when the body is not JSON. */
  body: unknown;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

/**
 * A server the user already runs (any OpenAI-compatible endpoint). Nothing is started or
 * stopped, load time is not measured; the API key stays in memory and never enters the plan.
 */
export class ExternalAdapter implements EngineAdapter {
  readonly kind = 'external' as const;
  /** Plans keep only host/port; the full endpoint (path, https, key) is remembered here. */
  private readonly endpoints = new WeakMap<LaunchPlan, Endpoint>();

  constructor(private readonly o: ExternalOptions) {}

  async detect(cfg?: EngineConfig): Promise<EngineStatus> {
    const base = { kind: this.kind, installed: true, supported: true } as const;
    if (!cfg?.baseUrl) return { ...base, available: false, problems: ['ENDPOINT_INVALID'] };
    try {
      const p = await this.probe(cfg);
      const status: EngineStatus = { ...base, available: true, location: cfg.baseUrl, variant: p.flavor, problems: [] };
      if (p.version !== undefined) status.version = p.version;
      return status;
    } catch (e) {
      return { ...base, available: false, location: cfg.baseUrl, problems: [toAppErrorData(e).code] };
    }
  }

  /**
   * Reachability + flavour: `owned_by` in /v1/models ("llamacpp", "vllm"), else llama.cpp's
   * /props or vLLM's /version, else plain OpenAI. An explicit cfg.flavor wins.
   */
  async probe(cfg: EngineConfig, signal?: AbortSignal): Promise<EndpointProbe> {
    const baseUrl = normalizeBaseUrl(cfg);
    const models = await this.request(baseUrl, '/v1/models', cfg.apiKey, signal);
    if (!models.ok) {
      const rejected = models.status === 401 || models.status === 403;
      throw new AppError('ENDPOINT_INVALID', rejected ? 'The endpoint rejected the API key' : `GET /v1/models returned ${models.status}`, {
        params: { status: models.status },
      });
    }
    const list = isRecord(models.body) && Array.isArray(models.body.data) ? (models.body.data as unknown[]) : [];
    const entries = list.filter(isRecord);
    const ids = entries.map((m) => m.id).filter((id): id is string => typeof id === 'string');
    const owners = entries.map((m) => m.owned_by);

    let flavor: ApiFlavor | undefined = cfg.flavor;
    let version: string | undefined;
    if (flavor === undefined && owners.includes('llamacpp')) flavor = 'llamacpp';
    if (flavor === undefined && owners.includes('vllm')) flavor = 'vllm';
    if (flavor === undefined || flavor === 'llamacpp') {
      const props = await this.request(baseUrl, '/props', cfg.apiKey, signal);
      if (props.ok && isRecord(props.body) && ('default_generation_settings' in props.body || 'build_info' in props.body)) {
        flavor = 'llamacpp';
        if (typeof props.body.build_info === 'string') version = props.body.build_info;
      }
    }
    if (flavor === undefined || flavor === 'vllm') {
      const v = await this.request(baseUrl, '/version', cfg.apiKey, signal);
      if (v.ok && isRecord(v.body) && typeof v.body.version === 'string') {
        flavor = 'vllm';
        version = v.body.version;
      }
    }
    const out: EndpointProbe = { flavor: flavor ?? 'openai', models: ids };
    if (version !== undefined) out.version = version;
    return out;
  }

  async capabilities(cfg: EngineConfig): Promise<EngineCaps> {
    const p = await this.probe(cfg);
    const caps: EngineCaps = {
      flags: new Set(),
      tokenIdsInPrompt: p.flavor !== 'openai' && p.flavor !== 'openai-chat',
      timings: p.flavor === 'llamacpp',
      minTokens: p.flavor === 'vllm',
      fitFlag: false,
      variant: p.flavor,
    };
    if (p.version !== undefined) caps.version = p.version;
    return caps;
  }

  /** No command: the engine identity is what the endpoint says it is. Falls back to cfg.flavor when unreachable. */
  async plan(cfg: EngineConfig, _model: ModelTarget, params: LaunchParams, opts: { port: number; marker: string }): Promise<LaunchPlan> {
    const baseUrl = normalizeBaseUrl(cfg);
    const url = new URL(baseUrl);
    const probe = await this.probe(cfg).catch(ignore);
    const flavor = probe?.flavor ?? cfg.flavor ?? 'openai';
    const engine: EngineIdentity = { kind: this.kind, name: FLAVOR_NAMES[flavor], variant: flavor };
    if (probe?.version !== undefined) engine.version = probe.version;
    const plan: LaunchPlan = {
      kind: this.kind,
      argv: [],
      env: {},
      host: url.hostname,
      port: url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80,
      params,
      engine,
      modelFiles: [],
      modelBytes: 0,
      marker: opts.marker,
    };
    this.endpoints.set(plan, { baseUrl, flavor, ...(cfg.apiKey ? { apiKey: cfg.apiKey } : {}) });
    return plan;
  }

  async start(plan: LaunchPlan, signal: AbortSignal): Promise<EngineInstance> {
    if (signal.aborted) throw new AppError('CANCELLED', 'Cancelled');
    // A plan rebuilt from a stored run (not from plan()) only has host/port: plain http, no key.
    const ep = this.endpoints.get(plan) ?? { baseUrl: `http://${plan.host}:${plan.port}`, flavor: (plan.engine.variant ?? 'openai') as ApiFlavor };
    const t0 = this.o.clock.now();
    let stopped!: (e: ExitInfo) => void;
    const exited = new Promise<ExitInfo>((r) => (stopped = r));
    const logs: AsyncIterable<LogLine> = { [Symbol.asyncIterator]: () => ({ next: () => Promise.resolve({ done: true, value: undefined }) }) };
    return {
      baseUrl: ep.baseUrl,
      t0,
      logs,
      waitReady: async (s) => {
        const res = await this.request(ep.baseUrl, '/v1/models', ep.apiKey, s ?? signal);
        if (res.status === 401 || res.status === 403) {
          throw new AppError('ENDPOINT_INVALID', 'The endpoint rejected the API key', { params: { status: res.status } });
        }
        return { tReady: this.o.clock.now(), phases: [] };
      },
      client: this.o.createClient(ep.flavor, ep.baseUrl, ep.apiKey ? { apiKey: ep.apiKey } : {}),
      stop: async () => {
        const e = { code: null, signal: null };
        stopped(e);
        return e;
      },
      exited,
      logTail: () => [],
    };
  }

  /** GET with the API key; the timeout covers headers and body. Unreachable → ENDPOINT_UNREACHABLE. */
  private async request(baseUrl: string, p: string, apiKey: string | undefined, signal?: AbortSignal): Promise<Fetched> {
    const t = timeoutSignal(this.o.probeTimeoutMs ?? 5000, signal);
    try {
      const res = await this.o.fetch(`${baseUrl}${p}`, {
        headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
        signal: t.signal,
      });
      const text = await res.text();
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        body = undefined;
      }
      return { status: res.status, ok: res.ok, body };
    } catch (e) {
      if (signal?.aborted) throw new AppError('CANCELLED', 'Cancelled', { cause: e });
      throw new AppError('ENDPOINT_UNREACHABLE', `Cannot reach ${baseUrl}`, { params: { url: baseUrl }, cause: e });
    } finally {
      t.clear();
    }
  }
}

/** "http://host:8000/v1/" → "http://host:8000" (we append /v1/... ourselves). */
export function normalizeBaseUrl(cfg: EngineConfig): string {
  if (!cfg.baseUrl) throw new AppError('ENDPOINT_INVALID', 'No endpoint URL configured');
  let u: URL;
  try {
    u = new URL(cfg.baseUrl);
  } catch {
    throw new AppError('ENDPOINT_INVALID', `Invalid endpoint URL: ${cfg.baseUrl}`);
  }
  const pathname = u.pathname.replace(/\/+$/, '').replace(/\/v1$/, '');
  return `${u.protocol}//${u.host}${pathname}`;
}
