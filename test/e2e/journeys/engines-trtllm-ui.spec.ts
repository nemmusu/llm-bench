/**
 * TensorRT-LLM as a person meets it, through the screens only: the Engines card (NGC's versions from a fake
 * registry, the recommended one to download, the native way inside WSL / on the PC), a benchmark in Docker
 * with its own settings from expert mode (the fake docker CLI runs the fake engine as trtllm-serve), how it
 * was started, then the card once the image is on the PC and its removal. The core's own journey (tune,
 * server, update through the API) is engines-trtllm.spec.ts.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { startFakeDockerApi } from '../../fakes/fake-docker/api.mjs';
import { expect, launchApp, test } from '../fixtures';
import { h1, openPage, scan, skipWelcome } from './library-helpers';

test.describe.configure({ timeout: 240_000 });

const REPO = 'nvidia/tensorrt-llm/release';
const IMAGE = 'nvcr.io/nvidia/tensorrt-llm/release';
const GB = 1024 ** 3;

/** NGC's registry API as the core reads it: an anonymous token, the tag list, each tag's manifest (its layers: the size). */
function startNgc(): Promise<{ url: string; server: Server }> {
  const tags = ['1.2.1', '1.3.0', '1.4.0rc0', '1.4.0rc0.dev2026101400'];
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const json = (status: number, body: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === '/proxy_auth') return json(200, { token: 'anonymous' });
    if (url.pathname === `/v2/${REPO}/tags/list`) return json(200, { name: REPO, tags });
    const tag = decodeURIComponent(new RegExp(`^/v2/${REPO}/manifests/(.+)$`).exec(url.pathname)?.[1] ?? '');
    if (tags.includes(tag)) return json(200, { schemaVersion: 2, config: { size: 20_000 }, layers: [{ size: 12 * GB }, { size: 6 * GB }] }, { 'docker-content-digest': `sha256:${'a'.repeat(63)}${tags.indexOf(tag)}` });
    return json(404, { errors: [{ code: 'NAME_UNKNOWN' }] });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server })));
}

let ngc: { url: string; server: Server };

test.beforeAll(async () => {
  ngc = await startNgc();
});

test.afterAll(async () => {
  await new Promise((r) => ngc.server.close(r));
});

async function waitForResult(page: Page, model: RegExp): Promise<void> {
  await expect(h1(page, 'Test in corso')).toBeVisible({ timeout: 60_000 });
  await expect(h1(page, model)).toBeVisible({ timeout: 120_000 });
  await expect(page.getByText('Completato', { exact: true })).toBeVisible();
}

test('TensorRT-LLM in Docker through the screens: NVIDIA’s recommended image, a benchmark with its own settings, then on the PC, in use, and removed', async () => {
  // An FP8 safetensors checkpoint in the library (TensorRT-LLM reads Hugging Face folders as they are).
  const userData = mkdtempSync(path.join(os.tmpdir(), 'gpubench-e2e-trtllm-ui-'));
  const dir = path.join(userData, 'models', 'local', 'Qwen3-0.6B-FP8');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, 'config.json'),
    JSON.stringify({ architectures: ['Qwen3ForCausalLM'], num_hidden_layers: 28, hidden_size: 1024, num_attention_heads: 16, num_key_value_heads: 8, head_dim: 128, max_position_embeddings: 40960, quantization_config: { quant_method: 'fp8' } }),
  );
  writeFileSync(path.join(dir, 'model.safetensors'), Buffer.alloc(4096));
  const profile = { loadMsCold: 600, loadMsWarm: 300, prefillTps: 60_000, decodeTps: 300, tokensPerChunk: 2, memory: { totalMiB: 32_000, freeMiB: 30_000, weightsMiB: 20_000, kvMiBPer1k: 300 } };
  // A Docker of its own (the journeys running at once share the default fake one, and what they pull).
  const docker = await startFakeDockerApi();
  const gb = await launchApp({ userData, env: { GPUBENCH_NGC_REGISTRY: ngc.url, FAKE_ENGINE_PROFILE: JSON.stringify(profile), GPUBENCH_DOCKER_HOST: docker.socketPath } });
  try {
    const { page } = gb;
    await skipWelcome(page);
    await openPage(page, 'Motori');
    const card = page.getByRole('region', { name: 'TensorRT-LLM' });
    await expect(card.getByText('Il motore di NVIDIA: spesso il più veloce con i modelli FP8 e NVFP4. Legge i modelli di Hugging Face (safetensors).')).toBeVisible();
    // The fake card is an RTX 5090: experimental there, said plainly.
    await expect(card.getByText('Sperimentale sulla tua scheda')).toBeVisible();
    // Nothing on the PC: one download, the recommended version with its size; the others behind "Tutte le versioni".
    await expect(card.getByRole('button', { name: /^Scarica TensorRT-LLM 1\.4\.0rc0 · 18,0 GB$/ })).toBeVisible({ timeout: 30_000 });
    await card.getByRole('button', { name: /^Tutte le versioni/ }).click();
    const versions = card.getByRole('list', { name: 'Versioni di TensorRT-LLM (immagini Docker)' });
    await expect(versions.getByText('1.2.1')).toBeVisible();
    await expect(versions.getByText('Anteprima').first()).toBeVisible();
    // The native way: inside WSL on Windows, on the PC itself on Linux.
    await card.getByRole('radio', { name: process.platform === 'win32' ? /In WSL/ : /Sul PC/ }).click();
    await expect(card.getByText(/ambiente Python tutto suo|dentro una distribuzione Linux di WSL/).first()).toBeVisible();
    await card.getByRole('radio', { name: /Docker/ }).click();
    await scan(page, 'trtllm card');

    await openPage(page, 'Benchmark');
    await page.getByRole('combobox', { name: 'Cambia motore' }).click();
    await page.getByRole('option', { name: /^TensorRT-LLM \(Docker\)/ }).click();
    await expect(page.getByRole('button', { name: /Cambia modello: .*Qwen3-0\.6B-FP8/ })).toBeVisible({ timeout: 30_000 });
    await page.getByRole('switch', { name: 'Modalità esperto' }).click();
    await page.getByLabel('Contesto per richiesta (token)').fill('8192');
    await page.getByLabel('Token per passo', { exact: true }).fill('4096');
    await page.getByRole('textbox', { name: 'Memoria per la cache KV' }).fill('0,8');
    await expect(page.getByRole('region', { name: 'Anteprima comando' })).toContainText(/--kv_cache_free_gpu_memory_fraction\s+'?0\.8/);
    await scan(page, 'trtllm expert fields');
    await page.getByRole('button', { name: 'Avvia benchmark' }).click();
    const confirm = page.getByRole('dialog', { name: 'Prima di iniziare scarico quello che manca' });
    await expect(confirm.getByText(/nvcr\.io\/nvidia\/tensorrt-llm\/release:1\.4\.0rc0/)).toBeVisible({ timeout: 30_000 });
    await confirm.getByRole('button', { name: 'Scarica e avvia' }).click();
    await waitForResult(page, /Qwen3-0\.6B-FP8/);
    await expect(page.getByText(/TensorRT-LLM 1\.4\.0rc0/).first()).toBeVisible();
    await page.getByRole('tab', { name: 'Come è stato avviato' }).click();
    await expect(page.getByText(/cache KV 80% della memoria libera/).first()).toBeVisible();
    await expect(page.getByText(/batch 4096 token/).first()).toBeVisible();
    await page.getByRole('button', { name: 'Mostra comando' }).click();
    await expect(page.getByRole('region', { name: 'Comando' })).toContainText('trtllm-serve');
    await scan(page, 'trtllm result');

    // The card: the image is on the PC and in use; removed after a confirmation, the download is offered again.
    await openPage(page, 'Motori');
    await expect(card.getByText('Pronto').first()).toBeVisible({ timeout: 30_000 });
    const row = card.getByRole('list', { name: 'Versioni di TensorRT-LLM (immagini Docker)' }).getByRole('listitem').first();
    await expect(row).toContainText('1.4.0rc0');
    await expect(row).toContainText('Sul PC');
    await expect(row).toContainText('In uso');
    await row.getByRole('button', { name: 'Rimuovi 1.4.0rc0' }).click();
    const remove = page.getByRole('alertdialog', { name: 'Rimuovere TensorRT-LLM 1.4.0rc0?' });
    await expect(remove).toContainText(`docker image rm ${IMAGE}:1.4.0rc0`);
    await remove.getByRole('button', { name: 'Rimuovi' }).click();
    await expect(page.getByText('TensorRT-LLM 1.4.0rc0 rimosso')).toBeVisible();
    await expect(card.getByRole('button', { name: /^Scarica TensorRT-LLM 1\.4\.0rc0/ })).toBeVisible({ timeout: 30_000 });
  } finally {
    await gb.close();
    await docker.close();
    rmSync(userData, { recursive: true, force: true });
  }
});
