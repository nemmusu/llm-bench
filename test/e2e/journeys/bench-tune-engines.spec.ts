/**
 * "Trova le impostazioni migliori" with the engines that read a safetensors checkpoint, in Docker (the
 * fake docker CLI runs the fake engine as vLLM or SGLang): the search runs on their own options
 * (--max-model-len, --kv-cache-dtype, the memory share, the chunk size), finds the largest context,
 *  and recommends a configuration with its speeds at that context.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, launchApp, test } from '../fixtures';
import { h1, skipWelcome } from './bench-helpers';
import { startLibraryWorld, type LibraryWorld } from './library-helpers';

test.describe.configure({ timeout: 300_000 });

let world: LibraryWorld;

test.beforeAll(async () => {
  world = await startLibraryWorld();
});

test.afterAll(async () => {
  await world.close();
});

const FAST = JSON.stringify({ loadMsCold: 300, loadMsWarm: 200, prefillTps: 200_000, decodeTps: 900, tokensPerChunk: 4 });

for (const engine of [
  { option: /^vLLM \(Docker\)/, flag: '--max-model-len', kv: '--kv-cache-dtype', image: /vllm\/vllm-openai/ },
  { option: /^SGLang \(Docker\)/, flag: '--context-length', kv: '--mem-fraction-static', image: /lmsysorg\/sglang/ },
]) {
  test(`the search with ${engine.option.source.replace(/[\\^]/g, '')}: its own options, a recommendation read at its largest context`, async () => {
    const userData = mkdtempSync(path.join(os.tmpdir(), 'gpubench-e2e-tune-engine-'));
    const dir = path.join(userData, 'models', 'local', 'Qwen3-0.6B');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, 'config.json'),
      JSON.stringify({ architectures: ['Qwen3ForCausalLM'], num_hidden_layers: 28, hidden_size: 1024, num_attention_heads: 16, num_key_value_heads: 8, max_position_embeddings: 16384 }),
    );
    writeFileSync(path.join(dir, 'model.safetensors'), Buffer.alloc(4096));
    const gb = await launchApp({ env: { ...world.env, FAKE_ENGINE_PROFILE: FAST }, userData });
    try {
      const { page } = gb;
      await skipWelcome(page);
      await page.getByRole('combobox', { name: 'Cambia motore' }).click();
      await page.getByRole('option', { name: engine.option }).click();
      await expect(page.getByRole('button', { name: /Cambia modello: .*Qwen3-0\.6B/ })).toBeVisible({ timeout: 30_000 });
      await page.getByRole('radio', { name: /Trova le impostazioni migliori/ }).click();
      await page.getByRole('button', { name: 'Avvia benchmark' }).click();
      const confirm = page.getByRole('dialog', { name: 'Prima di iniziare scarico quello che manca' });
      // The image is pulled first (the fake Docker has none yet).
      await confirm.getByRole('button', { name: 'Scarica e avvia' }).click();

      // Live: every launch with the engine's own options.
      await expect(h1(page, 'Test in corso')).toBeVisible({ timeout: 60_000 });
      const attempts = page.getByRole('table', { name: 'Prove fatte' });
      await expect(attempts.getByText('Caricato').first()).toBeVisible({ timeout: 120_000 });

      // The result: the five answers, the recommendation at its largest context, measured there.
      await expect(h1(page, /Qwen3-0\.6B/)).toBeVisible({ timeout: 240_000 });
      const brief = page.getByRole('list', { name: 'Le risposte principali' });
      await expect(brief.getByRole('listitem').first()).toContainText(/^1Al contesto più grande \(16K\)legge [\d.]+ tok\/s, scrive [\d.,]+ tok\/s/);
      await page.getByRole('tab', { name: 'Come è stato avviato' }).click();
      await page.getByRole('button', { name: 'Mostra comando' }).click();
      const command = page.getByRole('region', { name: 'Comando' });
      await expect(command).toContainText(engine.flag);
      await expect(command).toContainText(engine.kv);
      await expect(command).toContainText(engine.image);
    } finally {
      await gb.close();
      rmSync(userData, { recursive: true, force: true });
    }
  });
}
