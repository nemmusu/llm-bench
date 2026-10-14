import { afterAll, describe, expect, it } from 'vitest';
import type { EngineConfig, EngineKind, EngineStatus } from '../../../../../src/contract/engines';
import { AppError } from '../../../../../src/contract/errors';
import { settingsSchema, type Settings } from '../../../../../src/contract/settings';
import type { HubTag } from '../../../../../src/core/docker/hub';
import { withCustomEngines } from '../../../../../src/core/engines/custom/adapter';
import { EngineRegistry } from '../../../../../src/core/engines/registry';
import type { EngineAdapter, InstallPlan } from '../../../../../src/core/engines/types';
import { EngineUpdates, type UpdateProgress, type UpdateTag } from '../../../../../src/core/engines/updates/service';
import { json, routeFetch, steppingClock } from '../../docker/helpers';
import { checkoutOnDisk, fakeTools, type FakeGitState } from './fake-tools';

const cleanups: (() => void)[] = [];
afterAll(() => {
  for (const c of cleanups) c();
});

const DEFAULT_IMAGE: Partial<Record<EngineKind, string>> = { 'sglang-docker': 'lmsysorg/sglang:v0.5.21', 'vllm-docker': 'vllm/vllm-openai:v0.11.0', 'trtllm-docker': 'nvcr.io/nvidia/tensorrt-llm/release:1.4.0rc0' };

/** An adapter that installs by recording the plan (a docker pull, a uv install), with the status given. */
function adapter(kind: EngineKind, o: { status?: (cfg?: EngineConfig) => Partial<EngineStatus>; noInstall?: boolean } = {}) {
  const installs: InstallPlan[] = [];
  const seen: (EngineConfig | undefined)[] = [];
  const a: EngineAdapter & { installs: InstallPlan[]; seen: (EngineConfig | undefined)[] } = {
    kind,
    installs,
    seen,
    detect: async (cfg) => {
      seen.push(cfg);
      return { kind, available: true, installed: true, problems: [], supported: true, location: cfg?.image ?? DEFAULT_IMAGE[kind], ...o.status?.(cfg) };
    },
    capabilities: async () => ({ flags: new Set(), tokenIdsInPrompt: true, timings: true, minTokens: false, fitFlag: false }),
    plan: async () => {
      throw new Error('not here');
    },
    start: async () => {
      throw new Error('not here');
    },
    ...(o.noInstall
      ? {}
      : {
          installPlan: async (cfg: EngineConfig): Promise<InstallPlan> => ({ kind, label: kind, bytes: 10, items: [], data: cfg.image ? { image: cfg.image } : { spec: 'vllm' } }),
          install: async (plan: InstallPlan, progress: (p: { stage: string; bytesDone: number; bytesTotal?: number }) => void) => {
            installs.push(plan);
            progress({ stage: 'download', bytesDone: 5, bytesTotal: 10 });
            progress({ stage: 'done', bytesDone: 10 });
          },
        }),
  };
  return a;
}

interface Setup {
  settings?: Partial<Settings>;
  adapters?: ReturnType<typeof adapter>[];
  images?: Record<string, string[]>;
  hubTags?: Record<string, HubTag[]>;
  tagInfo?: Record<string, HubTag>;
  tags?: Partial<Record<'vllm-docker' | 'sglang-docker', UpdateTag[]>>;
  pypi?: Record<string, unknown>;
  git?: FakeGitState;
  wrap?: boolean;
  packages?: Partial<Record<'vllm-native' | 'sglang-native' | 'trtllm-native', string>>;
  /** TensorRT-LLM's NGC tags and the digest of the image's own tag there. */
  trtllm?: { tags: UpdateTag[]; remote?: UpdateTag; remoteFails?: boolean };
}

function setup(o: Setup = {}) {
  let settings: Settings = settingsSchema.parse(o.settings ?? {});
  const store = {
    get: async () => settings,
    update: async (patch: Partial<Settings>) => {
      settings = settingsSchema.parse({ ...settings, ...patch });
      return settings;
    },
  };
  const adapters = o.adapters ?? [adapter('sglang-docker'), adapter('vllm-docker'), adapter('vllm-native'), adapter('sglang-native'), adapter('llamacpp-native'), adapter('command')];
  const registry = new EngineRegistry(o.wrap === false ? adapters : withCustomEngines(adapters, { list: async () => settings.customEngines }));
  const pypiCalls: string[] = [];
  const fetch = routeFetch(
    Object.fromEntries(
      Object.entries(o.pypi ?? {}).map(([name, body]) => [
        `https://pypi.test/pypi/${name}/json`,
        () => {
          pypiCalls.push(name);
          return body instanceof Response ? body : json(body);
        },
      ]),
    ),
  );
  const tools = fakeTools(o.git ?? {});
  const tagRefreshes: boolean[] = [];
  const updates = new EngineUpdates({
    registry,
    settings: store,
    images: { inspect: async (ref) => (o.images?.[ref] ? { repoDigests: o.images[ref] } : undefined) },
    hub: {
      listTags: async (repo, _f, opts) => {
        tagRefreshes.push(opts?.refresh === true);
        return o.hubTags?.[repo] ?? [];
      },
      tagInfo: async (ref) => o.tagInfo?.[ref],
    },
    tags: {
      'vllm-docker': { tags: async () => o.tags?.['vllm-docker'] ?? [] },
      'sglang-docker': { tags: async () => o.tags?.['sglang-docker'] ?? [] },
      ...(o.trtllm
        ? {
            'trtllm-docker': {
              tags: async () => o.trtllm?.tags ?? [],
              remoteTag: async () => {
                if (o.trtllm?.remoteFails) throw new Error('ngc down');
                return o.trtllm?.remote;
              },
            },
          }
        : {}),
    },
    ...(o.packages ? { packages: o.packages } : {}),
    tools,
    fetch,
    pypi: 'https://pypi.test',
    clock: steppingClock(),
  });
  const progress: UpdateProgress[] = [];
  const update = (target: string) => updates.update(target, (p) => progress.push(p), new AbortController().signal);
  return { updates, update, progress, adapters, settings: () => settings, pypiCalls, tools, tagRefreshes };
}

const SG = 'lmsysorg/sglang';

describe('built-in Docker engines', () => {
  it('SGLang: a newer release tag, pulled and chosen for the next tests', async () => {
    const s = setup({ tags: { 'sglang-docker': [{ name: 'v0.5.21' }, { name: 'v0.5.22', sizeBytes: 9e9 }, { name: 'v0.5.22-cu130' }] } });
    const c = await s.updates.check('sglang-docker');
    expect(c).toMatchObject({ target: 'sglang-docker', method: 'docker-tag', state: 'available', current: 'v0.5.21', latest: 'v0.5.22', sizeBytes: 9e9, image: `${SG}:v0.5.22`, commands: [['docker', 'pull', `${SG}:v0.5.22`]] });
    expect(c.checkedAt).toMatch(/^\d{4}-/);
    expect(await s.update('sglang-docker')).toEqual({ version: 'v0.5.22' });
    expect(s.adapters[0]?.installs[0]?.data).toEqual({ image: `${SG}:v0.5.22` });
    // The pull's last step is the check of the new image, then the update says it is done.
    expect(s.progress).toEqual([
      { stage: 'download', bytesDone: 5, bytesTotal: 10 },
      { stage: 'verify', bytesDone: 10 },
    ]);
    expect(s.settings().lastEngine).toEqual({ kind: 'sglang-docker', image: `${SG}:v0.5.22` });
  });

  it('vLLM: the image in use; a newer tag that cannot run on this GPU is not offered; a newer build of the same tag is', async () => {
    const IMG = 'vllm/vllm-openai:v0.11.0';
    const s = setup({
      settings: { lastEngine: { kind: 'vllm-docker', image: IMG } },
      tags: { 'vllm-docker': [{ name: 'v0.12.0', supportsGpu: false }, { name: 'v0.11.0', digest: 'sha256:new', sizeBytes: 8e9 }] },
      images: { [IMG]: ['vllm/vllm-openai@sha256:old'] },
    });
    expect(await s.updates.check('vllm-docker')).toMatchObject({ method: 'docker-pull', state: 'available', current: 'v0.11.0', latest: 'v0.11.0', image: IMG, sizeBytes: 8e9 });
    expect(await s.update('vllm-docker')).toEqual({ version: 'v0.11.0' });
    expect(s.adapters[1]?.installs[0]?.data).toEqual({ image: IMG });
    // Same image: the choice stays as it was.
    expect(s.settings().lastEngine).toEqual({ kind: 'vllm-docker', image: IMG });
  });

  it('up to date; Docker off; the image not pulled yet; an image fixed by digest; a custom engine in use is not the built-in', async () => {
    const current = setup({ tags: { 'sglang-docker': [{ name: 'v0.5.21', digest: 'sha256:a' }] }, images: { [`${SG}:v0.5.21`]: [`${SG}@sha256:a`] } });
    expect(await current.updates.check('sglang-docker')).toMatchObject({ state: 'current', current: 'v0.5.21' });
    await expect(current.update('sglang-docker')).rejects.toMatchObject({ code: 'ENGINE_UPDATE_FAILED', params: { reason: 'current' } });

    const off = setup({ adapters: [adapter('sglang-docker', { status: () => ({ installed: false, available: false, problems: ['DOCKER_NOT_RUNNING'] }) })] });
    expect(await off.updates.check('sglang-docker')).toMatchObject({ state: 'blocked', reason: 'no-docker' });
    const missing = setup({ adapters: [adapter('sglang-docker', { status: () => ({ installed: false, problems: ['ENGINE_NOT_INSTALLED'] }) })] });
    expect(await missing.updates.check('sglang-docker')).toMatchObject({ state: 'blocked', reason: 'not-installed' });
    const pinned = setup({ settings: { lastEngine: { kind: 'sglang-docker', image: `${SG}@sha256:${'a'.repeat(64)}` } } });
    expect(await pinned.updates.check('sglang-docker')).toMatchObject({ method: 'none', state: 'none', reason: 'pinned' });

    const custom = setup({ settings: { lastEngine: { kind: 'sglang-docker', customEngineId: 'x', image: 'me/x:1' } }, tags: { 'sglang-docker': [{ name: 'v0.5.30' }] } });
    expect(await custom.updates.check('sglang-docker')).toMatchObject({ current: 'v0.5.21', latest: 'v0.5.30' });
    expect(custom.adapters[0]?.seen[0]).toEqual({ kind: 'sglang-docker' });
  });
});

const engine = (o: object) => ({ id: 'fork', name: 'Fork', extraArgs: [], env: {}, notes: '', ...o });

describe('custom engines in Docker', () => {
  it('another registry: no tag list to read, it can be pulled again', async () => {
    const IMG = 'ghcr.io/team/sglang:fp4';
    const s = setup({ settings: { customEngines: [engine({ base: 'sglang', run: { mode: 'docker', image: IMG } })] } as never });
    expect(await s.updates.check('custom:fork')).toMatchObject({ method: 'docker-pull', state: 'unknown', image: IMG, commands: [['docker', 'pull', IMG]] });
    expect(await s.updates.labelOf('custom:fork')).toBe('Fork');
    await s.update('custom:fork');
    expect(s.adapters[0]?.installs[0]?.data).toEqual({ image: IMG });
  });

  it('Docker Hub: a newer tag becomes the engine’s image; the other engines stay as they are', async () => {
    const other = engine({ id: 'other', name: 'Other', base: 'llamacpp', run: { mode: 'native', path: '/x/llama-server' } });
    const s = setup({
      settings: { customEngines: [engine({ base: 'vllm', run: { mode: 'docker', image: 'me/vllm-fork:v1.2.0' } }), other] } as never,
      hubTags: { 'me/vllm-fork': [{ name: 'v1.3.0', sizeBytes: 7 }, { name: 'v1.2.0' }] },
    });
    expect(await s.updates.check('custom:fork', { fetch: true })).toMatchObject({ method: 'docker-tag', latest: 'v1.3.0', image: 'me/vllm-fork:v1.3.0', sizeBytes: 7 });
    expect(s.tagRefreshes).toEqual([true]);
    await s.update('custom:fork');
    expect(s.settings().customEngines.map((e) => (e.run.mode === 'docker' ? e.run.image : e.run.mode))).toEqual(['me/vllm-fork:v1.3.0', 'native']);
    expect(s.settings().customEngines[0]).not.toHaveProperty('pulledImage');
    // An image LLM Bench pulled: the newer one is LLM Bench's too (deleting the engine can remove it).
    const pulled = setup({
      settings: { customEngines: [engine({ base: 'vllm', run: { mode: 'docker', image: 'me/vllm-fork:v1.2.0' }, pulledImage: 'me/vllm-fork:v1.2.0' } as never)] } as never,
      hubTags: { 'me/vllm-fork': [{ name: 'v1.3.0' }, { name: 'v1.2.0' }] },
    });
    await pulled.update('custom:fork');
    expect(pulled.settings().customEngines[0]).toMatchObject({ run: { image: 'me/vllm-fork:v1.3.0' }, pulledImage: 'me/vllm-fork:v1.3.0' });
  });

  it('Docker Hub, a moving tag: its digest against the local one', async () => {
    const IMG = 'me/llama-fork:latest';
    const fork = engine({ base: 'llamacpp', run: { mode: 'docker', image: IMG } });
    const adapters = [adapter('llamacpp-docker')];
    const newer = setup({ adapters, settings: { customEngines: [fork] } as never, tagInfo: { [IMG]: { name: 'latest', digest: 'sha256:b', sizeBytes: 3 } }, images: { [IMG]: ['me/llama-fork@sha256:a'] } });
    expect(await newer.updates.check('custom:fork')).toMatchObject({ method: 'docker-pull', state: 'available', sizeBytes: 3 });
    const same = setup({ adapters, settings: { customEngines: [fork] } as never, tagInfo: { [IMG]: { name: 'latest', digest: 'sha256:a' } }, images: { [IMG]: ['me/llama-fork@sha256:a'] } });
    expect(await same.updates.check('custom:fork')).toMatchObject({ state: 'current', current: 'latest' });
    // Not pulled through a registry (built here): nothing to compare.
    const local = setup({ adapters, settings: { customEngines: [fork] } as never, tagInfo: { [IMG]: { name: 'latest', digest: 'sha256:b' } } });
    expect(await local.updates.check('custom:fork')).toMatchObject({ state: 'current' });
    // No tag is "latest"; a size Docker Hub does not give is left out.
    const PLAIN = 'me/plain';
    const bare = setup({
      adapters,
      settings: { customEngines: [engine({ base: 'llamacpp', run: { mode: 'docker', image: PLAIN } })] } as never,
      tagInfo: { [PLAIN]: { name: 'latest', digest: 'sha256:b' } },
      images: { [PLAIN]: ['me/plain@sha256:a'] },
    });
    const c = await bare.updates.check('custom:fork');
    expect(c).toMatchObject({ state: 'available', current: 'latest' });
    expect(c).not.toHaveProperty('sizeBytes');
    expect(await bare.update('custom:fork')).toEqual({ version: 'latest' });
  });
});

describe('vLLM and SGLang installed with uv', () => {
  const vllm = (version: string, size?: number) => ({ info: { version }, urls: size ? [{ filename: `vllm-${version}-cp38-abi3-manylinux1_x86_64.whl`, size }] : [] });

  it('a newer PyPI release, installed pinned in the managed environment', async () => {
    const s = setup({
      adapters: [adapter('vllm-native', { status: () => ({ version: '0.11.0+cu129', location: '/e/vllm-venv/bin/vllm' }) })],
      pypi: { vllm: vllm('0.11.2', 4e8) },
    });
    expect(await s.updates.check('vllm-native')).toMatchObject({
      method: 'uv',
      state: 'available',
      current: '0.11.0+cu129',
      latest: '0.11.2',
      sizeBytes: 4e8,
      commands: [['uv', 'pip', 'install', 'vllm==0.11.2', '--torch-backend', 'auto']],
    });
    await s.update('vllm-native');
    expect(s.adapters[0]?.installs[0]?.data).toEqual({ spec: 'vllm==0.11.2' });
    expect(s.progress.at(-1)).toEqual({ stage: 'verify', bytesDone: 10 });
    // PyPI's answer is kept for a while; "Controlla aggiornamenti" asks again.
    expect(s.pypiCalls).toHaveLength(1);
    await s.updates.check('vllm-native', { fetch: true });
    expect(s.pypiCalls).toHaveLength(2);
  });

  it('SGLang with extras; up to date; an environment of the user’s own; not installed; not on this system', async () => {
    const sg = setup({
      adapters: [adapter('sglang-native', { status: () => ({ version: '0.5.21' }) })],
      pypi: { sglang: { info: { version: '0.5.22' }, urls: [] } },
      packages: { 'sglang-native': 'sglang[all]' },
    });
    expect(await sg.updates.check('sglang-native')).toMatchObject({ commands: [['uv', 'pip', 'install', 'sglang[all]==0.5.22', '--torch-backend', 'auto']] });
    expect(await sg.updates.labelOf('sglang-native')).toBe('SGLang');
    const plainSg = setup({ adapters: [adapter('sglang-native', { status: () => ({ version: '0.5.21' }) })], pypi: { sglang: { info: { version: '0.5.22' }, urls: [] } } });
    expect(await plainSg.updates.check('sglang-native')).toMatchObject({ commands: [['uv', 'pip', 'install', 'sglang==0.5.22', '--torch-backend', 'auto']] });

    const same = setup({ adapters: [adapter('vllm-native', { status: () => ({ version: '0.11.2' }) })], pypi: { vllm: vllm('0.11.2') } });
    expect(await same.updates.check('vllm-native')).toMatchObject({ state: 'current', current: '0.11.2' });
    const odd = setup({ adapters: [adapter('vllm-native', { status: () => ({ version: 'dev' }) })], pypi: { vllm: vllm('0.11.2') } });
    expect(await odd.updates.check('vllm-native')).toMatchObject({ state: 'current' });

    const own = setup({ settings: { lastEngine: { kind: 'vllm-native', vllmPath: '/home/me/venv' } } });
    expect(await own.updates.check('vllm-native')).toMatchObject({ method: 'none', reason: 'own-environment' });
    const ownSg = setup({ settings: { lastEngine: { kind: 'sglang-native', sglangPath: '/home/me/venv' } } });
    expect(await ownSg.updates.check('sglang-native')).toMatchObject({ reason: 'own-environment' });
    const none = setup({ adapters: [adapter('vllm-native', { status: () => ({ installed: false, version: undefined }) })] });
    expect(await none.updates.check('vllm-native')).toMatchObject({ state: 'blocked', reason: 'not-installed' });
    const windows = setup({ adapters: [adapter('sglang-native', { status: () => ({ supported: false }) })] });
    expect(await windows.updates.check('sglang-native')).toMatchObject({ state: 'none', reason: 'tools' });
  });

  it('PyPI out of reach: the check fails and is asked again next time', async () => {
    const s = setup({ adapters: [adapter('vllm-native', { status: () => ({ version: '0.11.0' }) })], pypi: { vllm: json({}, 503) } });
    await expect(s.updates.check('vllm-native')).rejects.toMatchObject({ code: 'NETWORK' });
    await expect(s.updates.check('vllm-native')).rejects.toMatchObject({ code: 'NETWORK' });
    expect(s.pypiCalls).toHaveLength(2);
  });
});

describe('a llama.cpp fork built from git', () => {
  const forkAt = (path: string) => ({ customEngines: [engine({ name: 'PrismML', base: 'llamacpp', run: { mode: 'native', path } })] }) as never;
  const disk = () => {
    const c = checkoutOnDisk();
    cleanups.push(c.cleanup);
    return c;
  };

  it('new commits upstream: pull, build, and the new build must start', async () => {
    const c = disk();
    const s = setup({ settings: forkAt(c.exe), git: { behind: 3 } });
    const check = await s.updates.check('custom:fork', { fetch: true });
    expect(check).toMatchObject({ method: 'git', state: 'available', commits: 3, current: 'a1b2c3d', latest: 'e4f5a6b', branch: 'master', repo: c.repo, buildDir: c.build });
    expect(check.commands).toEqual([
      ['git', '-C', c.repo, 'pull', '--ff-only'],
      ['cmake', '--build', c.build, '-j'],
    ]);
    expect(await s.update('custom:fork')).toEqual({ version: 'e4f5a6b' });
    expect(s.progress.map((p) => p.stage)).toEqual(['git-pull', 'build', 'build', 'build', 'verify']);
    // The engine's own check ran on the fork's executable.
    expect(s.adapters.find((a) => a.kind === 'llamacpp-native')?.seen.at(-1)).toMatchObject({ kind: 'llamacpp-native', executable: c.exe });
  });

  it('a rebuilt engine that does not start is an error', async () => {
    const c = disk();
    const s = setup({ settings: forkAt(c.exe), git: { behind: 1 }, adapters: [adapter('llamacpp-native', { status: () => ({ available: false, problems: ['ENGINE_START_FAILED'] }) })] });
    await expect(s.update('custom:fork')).rejects.toMatchObject({ code: 'ENGINE_UPDATE_FAILED', params: { reason: 'verify' } });
  });

  it('every reason not to touch it', async () => {
    const c = disk();
    const check = (git: FakeGitState) => setup({ settings: forkAt(c.exe), git }).updates.check('custom:fork', { fetch: true });
    expect(await check({ behind: 0 })).toMatchObject({ state: 'current', current: 'a1b2c3d' });
    expect(await check({ changed: 2, behind: 1 })).toMatchObject({ state: 'blocked', reason: 'dirty', changed: 2 });
    expect(await check({ behind: 2, ahead: 1 })).toMatchObject({ state: 'blocked', reason: 'diverged', commits: 2 });
    expect(await check({ fetchFails: 'Could not resolve host' })).toMatchObject({ state: 'blocked', reason: 'fetch-failed', detail: 'Could not resolve host' });
    expect(await check({ branch: 'HEAD' })).toMatchObject({ state: 'blocked', reason: 'detached' });
    expect(await check({ upstream: null })).toMatchObject({ state: 'blocked', reason: 'no-upstream', branch: 'master' });
    expect(await check({ missing: true })).toMatchObject({ state: 'blocked', reason: 'git-missing' });
    expect(await check({ behind: 1, cmakeMissing: true })).toMatchObject({ state: 'blocked', reason: 'cmake-missing', commits: 1 });
  });

  it('a build outside git, a vLLM fork, a program of the user’s own: updated with their own tools', async () => {
    const s = setup({
      settings: {
        customEngines: [
          engine({ id: 'plain', base: 'llamacpp', run: { mode: 'native', path: '/nowhere/llama-server' } }),
          engine({ id: 'v', base: 'vllm', run: { mode: 'native', path: '/venv' } }),
          engine({ id: 'srv', base: 'openai-server', run: { mode: 'command', template: 'srv --port {port}' } }),
        ],
      } as never,
    });
    for (const id of ['plain', 'v', 'srv']) expect(await s.updates.check(`custom:${id}`)).toMatchObject({ method: 'none', state: 'none', reason: 'tools' });
  });
});

describe('targets', () => {
  it('unknown targets and engines, labels, adapters that cannot install', async () => {
    const s = setup();
    await expect(s.updates.check('llamacpp-native')).rejects.toMatchObject({ code: 'VALIDATION', params: { reason: 'update_target' } });
    await expect(s.updates.check('custom:')).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(s.updates.check('custom:gone')).rejects.toMatchObject({ code: 'ENGINE_NOT_INSTALLED', params: { reason: 'custom_engine_missing' } });
    expect(await s.updates.labelOf('vllm-docker')).toBe('vLLM (Docker)');
    const bare = setup({ wrap: false, adapters: [adapter('sglang-docker', { noInstall: true })] });
    await expect(bare.updates.check('sglang-docker')).rejects.toMatchObject({ code: 'VALIDATION' });
    expect(new AppError('ENGINE_UPDATE_FAILED', 'x').code).toBe('ENGINE_UPDATE_FAILED');
  });
});

describe('TensorRT-LLM', () => {
  const TRT = 'nvcr.io/nvidia/tensorrt-llm/release';
  const trtAdapters = () => [adapter('trtllm-docker'), adapter('trtllm-native', { status: () => ({ version: '1.2.1', variant: 'Ubuntu' }) })];

  it('its NGC image: a newer release candidate, pulled and chosen', async () => {
    const s = setup({ adapters: trtAdapters(), trtllm: { tags: [{ name: '1.4.0rc0' }, { name: '1.4.0rc1', sizeBytes: 17e9 }, { name: '1.2.1' }] } });
    expect(await s.updates.labelOf('trtllm-docker')).toBe('TensorRT-LLM (Docker)');
    expect(await s.updates.labelOf('trtllm-native')).toBe('TensorRT-LLM');
    const c = await s.updates.check('trtllm-docker');
    expect(c).toMatchObject({ method: 'docker-tag', state: 'available', current: '1.4.0rc0', latest: '1.4.0rc1', sizeBytes: 17e9, image: `${TRT}:1.4.0rc1` });
    expect(await s.update('trtllm-docker')).toEqual({ version: '1.4.0rc1' });
    expect(s.settings().lastEngine).toMatchObject({ kind: 'trtllm-docker', image: `${TRT}:1.4.0rc1` });
  });

  it('the same tag rebuilt on NGC: pulled again; the same digest: current; NGC silent: current', async () => {
    const digest = `sha256:${'a'.repeat(64)}`;
    const images = { [`${TRT}:1.4.0rc0`]: [`${TRT}@${digest}`] };
    const newer = setup({ adapters: trtAdapters(), images, trtllm: { tags: [{ name: '1.4.0rc0' }], remote: { name: '1.4.0rc0', digest: `sha256:${'b'.repeat(64)}`, sizeBytes: 5 } } });
    expect(await newer.updates.check('trtllm-docker')).toMatchObject({ method: 'docker-pull', state: 'available', current: '1.4.0rc0', sizeBytes: 5 });
    const same = setup({ adapters: trtAdapters(), images, trtllm: { tags: [], remote: { name: '1.4.0rc0', digest } } });
    expect(await same.updates.check('trtllm-docker')).toMatchObject({ state: 'current', current: '1.4.0rc0' });
    const down = setup({ adapters: trtAdapters(), images, trtllm: { tags: [], remoteFails: true } });
    expect(await down.updates.check('trtllm-docker')).toMatchObject({ state: 'current' });
    // Without NGC wired in: like any other registry, it can be pulled again.
    const none = setup({ adapters: trtAdapters(), images });
    expect(await none.updates.check('trtllm-docker')).toMatchObject({ state: 'unknown' });
  });

  it('its Python environment, in WSL: against PyPI, the distro named', async () => {
    const s = setup({ adapters: trtAdapters(), pypi: { 'tensorrt-llm': { info: { version: '1.2.2' }, urls: [] } } });
    const c = await s.updates.check('trtllm-native');
    expect(c).toMatchObject({ method: 'uv', state: 'available', current: '1.2.1', latest: '1.2.2', distro: 'Ubuntu', commands: [['uv', 'pip', 'install', 'tensorrt-llm==1.2.2', '--torch-backend', 'auto']] });
    expect(s.pypiCalls).toEqual(['tensorrt-llm']);
    const own = setup({ adapters: trtAdapters(), settings: { lastEngine: { kind: 'trtllm-native', trtllmPath: '/opt/py' } } });
    expect(await own.updates.check('trtllm-native')).toMatchObject({ state: 'none', reason: 'own-environment' });
    const linux = setup({ adapters: [adapter('trtllm-native', { status: () => ({ version: '1.2.1' }) })], pypi: { 'tensorrt-llm': { info: { version: '1.2.1' }, urls: [] } } });
    expect(await linux.updates.check('trtllm-native')).not.toHaveProperty('distro');
  });
});