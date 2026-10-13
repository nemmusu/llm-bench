import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { launchParamsSchema } from '../../../../../src/contract/engines';
import { DockerCli } from '../../../../../src/core/docker/cli';
import type { DockerEnvironment } from '../../../../../src/core/docker/environment';
import { DockerHubClient } from '../../../../../src/core/docker/hub';
import type { ImageService } from '../../../../../src/core/docker/images';
import { LlamaDockerAdapter } from '../../../../../src/core/engines/llamacpp-docker/adapter';
import { containerPaths, HOST_PATH_OPTIONS, VLLM_JSON_MODEL_OPTIONS } from '../../../../../src/core/engines/shared/docker-paths';
import { SglangDockerAdapter } from '../../../../../src/core/engines/sglang-docker/adapter';
import type { ModelTarget } from '../../../../../src/core/engines/types';
import { VllmDockerAdapter } from '../../../../../src/core/engines/vllm-docker/adapter';
import { ok, RESOURCES, routeFetch, scriptedProc, silentLog, steppingClock, tempDir } from '../../docker/helpers';

const cleanups: (() => void)[] = [];
afterAll(() => {
  for (const c of cleanups) c();
});

describe('containerPaths', () => {
  const posix = (exists: string[]) => ({ host: path.posix, exists: (p: string) => exists.includes(p) });

  it('rewrites a draft next to the model and mounts one elsewhere once (Linux)', () => {
    const out = containerPaths(['-md', '/m/draft.gguf', '--mmproj=/other/mmproj.gguf', '--lora', '/other/style.gguf', '-c', '4096'], {
      options: HOST_PATH_OPTIONS.llamacpp,
      mounted: [{ hostDir: '/m', containerDir: '/models' }],
      ...posix(['/m/draft.gguf', '/other/mmproj.gguf', '/other/style.gguf']),
    });
    expect(out.args).toEqual(['-md', '/models/draft.gguf', '--mmproj=/aux/0/mmproj.gguf', '--lora', '/aux/0/style.gguf', '-c', '4096']);
    expect(out.volumes).toEqual(['/other:/aux/0:ro']);
  });

  it('leaves what is not a host path: repo ids, relative names, paths inside the image, a flag without value', () => {
    const out = containerPaths(['--speculative-draft-model-path', 'Qwen/Qwen3-0.6B', '-md', 'draft.gguf', '-mm', '/opt/in-image/mmproj.gguf', '--model-draft'], {
      options: [...HOST_PATH_OPTIONS.sglang, ...HOST_PATH_OPTIONS.llamacpp],
      mounted: [],
      ...posix([]),
    });
    expect(out).toEqual({ args: ['--speculative-draft-model-path', 'Qwen/Qwen3-0.6B', '-md', 'draft.gguf', '-mm', '/opt/in-image/mmproj.gguf', '--model-draft'], volumes: [] });
  });

  it('mounts a model folder itself, and maps the mounted folder and paths under it', () => {
    const out = containerPaths(['--speculative-draft-model-path', '/hf/eagle', '--speculative-draft-model-path', '/hf/eagle/sub/x.safetensors', '--speculative-model', '/models-dir'], {
      options: [...HOST_PATH_OPTIONS.sglang, ...HOST_PATH_OPTIONS.vllm],
      mounted: [{ hostDir: '/models-dir', containerDir: '/models/m' }],
      ...posix(['/hf/eagle', '/hf/eagle/sub/x.safetensors', '/models-dir']),
    });
    expect(out.args).toEqual(['--speculative-draft-model-path', '/aux/0', '--speculative-draft-model-path', '/aux/0/sub/x.safetensors', '--speculative-model', '/models/m']);
    expect(out.volumes).toEqual(['/hf/eagle:/aux/0:ro']);
  });

  it("vLLM's --speculative-config: the JSON's model, in both spellings; other JSON as it is", () => {
    const o = { options: HOST_PATH_OPTIONS.vllm, jsonModelOptions: VLLM_JSON_MODEL_OPTIONS, mounted: [], ...posix(['/d/draft']) };
    const out = containerPaths(['--speculative-config', '{"model":"/d/draft","num_speculative_tokens":3}', '--speculative-config={"method":"mtp"}'], o);
    expect(out.args).toEqual(['--speculative-config', '{"model":"/aux/0","num_speculative_tokens":3}', '--speculative-config={"method":"mtp"}']);
    for (const v of ['not json', '[1]', 'null', '{"model":"Qwen/x"}']) expect(containerPaths(['--speculative-config', v], o).args).toEqual(['--speculative-config', v]);
  });

  it('Windows paths: drive letters, case-insensitive folders, another drive', () => {
    const out = containerPaths(['-md', 'C:\\Models\\Qwen\\draft.gguf', '-mm', 'D:\\proj\\mmproj.gguf', '--other=x'], {
      options: HOST_PATH_OPTIONS.llamacpp,
      mounted: [{ hostDir: 'c:\\models\\qwen', containerDir: '/models' }],
      host: path.win32,
      exists: () => true,
    });
    expect(out.args).toEqual(['-md', '/models/draft.gguf', '-mm', '/aux/0/mmproj.gguf', '--other=x']);
    expect(out.volumes).toEqual(['D:\\proj:/aux/0:ro']);
  });
});

/** Docker adapters planning with a draft model or a projector on the host. */
describe('Docker engines mount the files their arguments name', () => {
  const platform = process.platform === 'win32' ? ('win32' as const) : ('linux' as const);
  const common = () => {
    const proc = scriptedProc(() => ok());
    const deps = {
      clock: steppingClock(),
      proc,
      fetch: routeFetch({}),
      platform,
      log: silentLog,
      paths: { dataDir: '', cacheDir: '', enginesDir: '', resultsDir: '', modelsDir: '', resourcesDir: RESOURCES, home: '' },
    } as const;
    return {
      deps,
      cli: new DockerCli({ proc, platform: 'linux', env: {}, override: ['docker'] }),
      environment: { status: async () => ({ state: 'running' }), noteGpuFailure: () => undefined } as unknown as DockerEnvironment,
      images: { inspect: async () => undefined } as unknown as ImageService,
      hub: new DockerHubClient({ fetch: routeFetch({}), baseUrl: 'https://hub.test', clock: steppingClock() }),
      createClient: () => ({}) as never,
    };
  };
  const files = () => {
    const t = tempDir('gb-dpath-');
    cleanups.push(t.cleanup);
    const modelDir = path.join(t.dir, 'model');
    const auxDir = path.join(t.dir, 'drafts');
    mkdirSync(modelDir);
    mkdirSync(path.join(auxDir, 'eagle'), { recursive: true });
    for (const f of [path.join(modelDir, 'm.gguf'), path.join(modelDir, 'mmproj.gguf'), path.join(auxDir, 'draft.gguf'), path.join(modelDir, 'config.json')]) writeFileSync(f, 'x');
    return { modelDir, auxDir };
  };
  const vol = (argv: readonly string[]) => argv.filter((_, i) => argv[i - 1] === '-v');

  it('llama.cpp: the projector next to the model, the draft in a mount of its own', async () => {
    const { modelDir, auxDir } = files();
    const main = path.join(modelDir, 'm.gguf');
    const identity = { displayName: 'm', format: 'gguf' as const, source: 'local' as const, files: [], weakKey: 'm' };
    const model: ModelTarget = { identity, local: { id: 'x', identity, paths: [main], auxiliary: [], dir: modelDir, origin: 'library', modifiedAt: '' } };
    const params = launchParamsSchema.parse({ extraArgs: ['-md', path.join(auxDir, 'draft.gguf'), '--mmproj', path.join(modelDir, 'mmproj.gguf')] });
    const a = new LlamaDockerAdapter(common());
    const plan = await a.plan({ kind: 'llamacpp-docker' }, model, params, { port: 1, marker: 'gpubench-d1' });
    expect(vol(plan.argv)).toEqual([`${modelDir}:/models:ro`, `${auxDir}:/aux/0:ro`]);
    expect(plan.argv.join(' ')).toContain('-md /aux/0/draft.gguf --mmproj /models/mmproj.gguf');
    // The run keeps the arguments as the user wrote them.
    expect(plan.params.extraArgs).toEqual(params.extraArgs);
    // A named volume holds only the model: the projector is mounted from the host.
    const inVolume = await a.plan({ kind: 'llamacpp-docker', modelVolume: 'gpubench-models' }, model, params, { port: 1, marker: 'gpubench-d2' });
    expect(vol(inVolume.argv)).toEqual(['gpubench-models:/models:ro', `${auxDir}:/aux/0:ro`, `${modelDir}:/aux/1:ro`]);
  });

  it('vLLM and SGLang: a draft model folder for speculative decoding', async () => {
    const { modelDir, auxDir } = files();
    const eagle = path.join(auxDir, 'eagle');
    const identity = { displayName: 'q', format: 'safetensors' as const, source: 'local' as const, files: [], weakKey: 'q' };
    const model: ModelTarget = { identity, local: { id: 'l', identity, paths: [], auxiliary: [], dir: modelDir, origin: 'library', modifiedAt: '' } };
    const vllm = await new VllmDockerAdapter(common()).plan(
      { kind: 'vllm-docker' },
      model,
      launchParamsSchema.parse({ extraArgs: ['--speculative-config', JSON.stringify({ model: eagle, num_speculative_tokens: 2 })] }),
      { port: 1, marker: 'gpubench-v' },
    );
    expect(vol(vllm.argv)).toContain(`${eagle}:/aux/0:ro`);
    expect(vllm.argv).toContain('{"model":"/aux/0","num_speculative_tokens":2}');
    const sglang = await new SglangDockerAdapter(common()).plan(
      { kind: 'sglang-docker' },
      model,
      launchParamsSchema.parse({ extraArgs: ['--speculative-draft-model-path', eagle] }),
      { port: 1, marker: 'gpubench-s' },
    );
    expect(vol(sglang.argv)).toContain(`${eagle}:/aux/0:ro`);
    expect(sglang.argv.join(' ')).toContain('--speculative-draft-model-path /aux/0');
    // A Hugging Face repo needs nothing mounted.
    const repo: ModelTarget = { identity: { displayName: 'r', format: 'safetensors', source: 'hf', repo: 'Qwen/Qwen3-8B', files: [], weakKey: 'r' } };
    const fromHub = await new SglangDockerAdapter(common()).plan({ kind: 'sglang-docker' }, repo, launchParamsSchema.parse({ extraArgs: ['--speculative-draft-model-path', 'Qwen/Qwen3-0.6B'] }), { port: 1, marker: 'gpubench-s2' });
    expect(fromHub.argv.join(' ')).toContain('--speculative-draft-model-path Qwen/Qwen3-0.6B');
    expect(vol(fromHub.argv).some((v) => v.includes('/aux/'))).toBe(false);
  });
});
