/**
 * NVIDIA TensorRT-LLM in Docker, end to end in the real app: its release tags from (a fake) NGC, the image
 * pulled by the fake docker CLI, a benchmark, a "Trova le impostazioni migliori" search and a server, all on
 * the fake engine answering as trtllm-serve; then its "Aggiorna" and "Rimuovi". The Engines card and the
 * Benchmark form for it are the UI's own work: this journey drives the app through the same core API they
 * use (the window's own connection), and reads the result where a person does.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { expect, launchApp, test } from '../fixtures';
import { goToHash } from '../ui/helpers';
import { h1, skipWelcome } from './bench-helpers';

test.describe.configure({ timeout: 300_000 });

const IMAGE = 'nvcr.io/nvidia/tensorrt-llm/release:1.4.0rc0';
const REPO = 'nvidia/tensorrt-llm/release';

/** A small nvcr.io: an anonymous token, the release tags (a newer candidate among them), manifests with sizes. */
async function startFakeNgc(): Promise<{ url: string; close(): Promise<void> }> {
  const server = http.createServer((req, res) => {
    const url = req.url ?? '/';
    const json = (body: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(200, { 'content-type': 'application/json', ...headers });
      res.end(JSON.stringify(body));
    };
    if (url.startsWith('/proxy_auth')) return json({ token: 'anon', expires_in: 600 });
    if (url === `/v2/${REPO}/tags/list`) return json({ name: REPO, tags: ['1.2.1', '1.4.0rc0', '1.4.0rc1', '1.4.0rc2.dev2026101400', 'gb300-ea'] });
    const tag = new RegExp(`^/v2/${REPO}/manifests/([^/]+)$`).exec(url)?.[1];
    if (tag?.startsWith('sha256')) return json({ layers: [{ size: 17_000_000_000 }], config: { size: 1000 } });
    if (tag) return json({ manifests: [{ digest: `sha256:${'e'.repeat(64)}`, platform: { architecture: 'amd64', os: 'linux' } }] }, { 'docker-content-digest': `sha256:${tag.replace(/\W/g, '').padEnd(64, '0').slice(0, 64)}` });
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

/** The core API with the window's own connection. */
async function coreApi(page: Page) {
  const conn = await page.evaluate(() => (window as unknown as { gpubench: { connection(): Promise<{ baseUrl: string; token: string }> } }).gpubench.connection());
  const call = async <T>(method: string, p: string, body?: unknown): Promise<T> => {
    const res = await fetch(`${conn.baseUrl}${p}`, { method, headers: { authorization: `Bearer ${conn.token}`, 'content-type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const data = (await res.json()) as T;
    expect(res.ok, `${method} ${p}: ${JSON.stringify(data)}`).toBe(true);
    return data;
  };
  /** A run once it is over (it is saved when it ends; while it runs it is the active one). */
  const finished = async (runId: string, timeout: number): Promise<void> => {
    await expect
      .poll(async () => (await fetch(`${conn.baseUrl}/api/runs/${runId}`, { headers: { authorization: `Bearer ${conn.token}` } })).status, { timeout, intervals: [1000] })
      .toBe(200);
  };
  return { get: <T>(p: string) => call<T>('GET', p), post: <T>(p: string, b: unknown = {}) => call<T>('POST', p, b), del: <T>(p: string) => call<T>('DELETE', p), finished };
}

interface Status {
  kind: string;
  installed: boolean;
  available: boolean;
  problems: string[];
  version?: string;
  location?: string;
}

test('TensorRT-LLM in Docker: tags from NGC, pulled, benchmarked, tuned, served, updated and removed', async () => {
  const ngc = await startFakeNgc();
  const userData = mkdtempSync(path.join(os.tmpdir(), 'gpubench-e2e-trtllm-'));
  // An FP8 checkpoint in the library (TensorRT-LLM reads Hugging Face folders as they are).
  const dir = path.join(userData, 'models', 'local', 'Qwen3-0.6B-FP8');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, 'config.json'),
    JSON.stringify({ architectures: ['Qwen3ForCausalLM'], num_hidden_layers: 28, hidden_size: 1024, num_attention_heads: 16, num_key_value_heads: 8, head_dim: 128, max_position_embeddings: 40960, quantization_config: { quant_method: 'fp8' } }),
  );
  writeFileSync(path.join(dir, 'model.safetensors'), Buffer.alloc(4096));
  // Its KV pool takes 0.9 of what the weights leave: f16-like 'auto' holds ~27K tokens, fp8 twice that.
  const profile = { loadMsCold: 600, loadMsWarm: 300, prefillTps: 60_000, decodeTps: 300, tokensPerChunk: 2, memory: { totalMiB: 32_000, freeMiB: 30_000, weightsMiB: 20_000, kvMiBPer1k: 300 } };
  const gb = await launchApp({ userData, env: { GPUBENCH_NGC_REGISTRY: ngc.url, FAKE_ENGINE_PROFILE: JSON.stringify(profile) } });
  try {
    const { page } = gb;
    await skipWelcome(page);
    const api = await coreApi(page);
    const status = async () => (await api.get<Status[]>('/api/engines')).find((s) => s.kind === 'trtllm-docker') as Status;

    // Not there yet: the image is what is missing. Its releases come from NGC, newest first, nightlies left out.
    expect(await status()).toMatchObject({ installed: false, problems: ['ENGINE_NOT_INSTALLED'], location: IMAGE });
    const tags = await api.get<{ name: string; recommended: boolean; sizeBytes?: number }[]>('/api/engines/trtllm/tags');
    expect(tags.map((t) => t.name)).toEqual(['1.4.0rc1', '1.4.0rc0', '1.2.1']);
    expect(tags.find((t) => t.recommended)).toMatchObject({ name: '1.4.0rc0', sizeBytes: 17_000_001_000 });

    // The install pulls the recommended image.
    await api.post('/api/engines/trtllm-docker/install');
    await expect.poll(async () => (await status()).installed, { timeout: 60_000 }).toBe(true);
    expect(await status()).toMatchObject({ available: true, version: '1.4.0rc0' });

    // A benchmark of the library model.
    const local = (await api.get<{ id: string; identity: { displayName: string } }[]>('/api/models/local')).find((m) => m.identity.displayName.includes('Qwen3-0.6B-FP8'));
    expect(local).toBeDefined();
    const engine = { kind: 'trtllm-docker' };
    const model = { localId: local!.id };
    const plan = await api.post<{ command: { argv: string[] } }>('/api/runs/plan', { engine, model, profile: 'quick' });
    expect(plan.command.argv).toEqual(expect.arrayContaining([IMAGE, 'trtllm-serve', 'serve', '--max_seq_len', '--kv_cache_free_gpu_memory_fraction', '--enable_chunked_prefill']));
    const run = await api.post<{ runId: string }>('/api/runs', { engine, model, profile: 'quick' });
    await api.finished(run.runId, 120_000);
    const done = await api.get<{ status: string; error?: unknown; logExcerpt?: unknown }>(`/api/runs/${run.runId}`);
    expect(done.status, JSON.stringify({ error: done.error, log: done.logExcerpt })).toBe('completed');
    const result = await api.get<{ engine: { name: string; version?: string }; metrics: { latency: unknown[] } }>(`/api/runs/${run.runId}`);
    expect(result.engine).toMatchObject({ name: 'TensorRT-LLM', version: '1.4.0rc0' });
    expect(result.metrics.latency.length).toBeGreaterThan(0);
    // Where a person reads it.
    await goToHash(page, `/results/${run.runId}`);
    await expect(h1(page, /Qwen3-0\.6B-FP8/)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/TensorRT-LLM 1\.4\.0rc0/).first()).toBeVisible();

    // "Trova le impostazioni migliori": fp8 holds the whole trained context, 'auto' less.
    const tune = await api.post<{ runId: string }>('/api/runs', { engine, model, profile: 'tune', tune: { budget: 'fast', fidelity: false } });
    await api.finished(tune.runId, 200_000);
    expect((await api.get<{ status: string }>(`/api/runs/${tune.runId}`)).status).toBe('completed');
    const tuned = await api.get<{ tuning: { recommended: number; combinations: { kvType: string; maxContext: number; params: { kvCacheType?: string } }[] } }>(`/api/runs/${tune.runId}`);
    const best = tuned.tuning.combinations[tuned.tuning.recommended]!;
    expect(best.kvType).toBe('fp8');
    expect(best.maxContext).toBeGreaterThan(30_000);
    expect(tuned.tuning.combinations.find((c) => c.kvType === 'auto')?.maxContext ?? 0).toBeLessThan(best.maxContext);

    // A server for other programs: the tuned settings, the model under its own name.
    const server = await api.post<{ id: string; port: number }>('/api/servers', { engine, model });
    const listed = async () => (await api.get<{ id: string; loading?: unknown; modelName: string }[]>('/api/servers')).find((s) => s.id === server.id);
    await expect.poll(async () => (await listed())?.loading, { timeout: 60_000 }).toBeUndefined();
    const models = (await (await fetch(`http://127.0.0.1:${server.port}/v1/models`)).json()) as { data: { id: string; owned_by: string }[] };
    expect(models.data[0]).toEqual(expect.objectContaining({ id: (await listed())?.modelName, owned_by: 'tensorrt_llm' }));
    await api.del(`/api/servers/${server.id}`);

    // "Aggiorna": a newer release candidate on NGC.
    const check = await api.get<{ state: string; latest?: string; image?: string }>('/api/engines/trtllm-docker/update?fetch=1');
    expect(check).toMatchObject({ state: 'available', latest: '1.4.0rc1', image: 'nvcr.io/nvidia/tensorrt-llm/release:1.4.0rc1' });

    // "Rimuovi": docker image rm (the fake docker CLI records it).
    await api.del('/api/engines/trtllm-docker/install');
    const images = JSON.parse(readFileSync(path.join(userData, 'fake-docker', 'images.json'), 'utf8')) as { removed?: string[] };
    expect(images.removed).toContain(IMAGE);
  } finally {
    await gb.close();
    await ngc.close();
    rmSync(userData, { recursive: true, force: true });
  }
});
