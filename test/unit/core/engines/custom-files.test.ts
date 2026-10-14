/**
 * Deleting a custom engine: what LLM Bench added for it (a checkout it built, an image it pulled when the
 * PC did not have it) can go with it, never the user's own files; refused while a test or a server runs.
 */
import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { customEngineSchema, type CustomEngine, type CustomEngineFiles } from '../../../../src/contract/custom-engines';
import type { EngineStatus } from '../../../../src/contract/engines';
import { settingsSchema, type Settings } from '../../../../src/contract/settings';
import type { CoreContext } from '../../../../src/core/context';
import { withCustomEngines } from '../../../../src/core/engines/custom/adapter';
import { createCustomEngineFiles } from '../../../../src/core/engines/custom/files';
import { createCustomEngineRoutes, type CustomEnginesDeps } from '../../../../src/core/engines/custom/routes';
import { EngineRegistry } from '../../../../src/core/engines/registry';
import type { EngineAdapter, InstallPlan } from '../../../../src/core/engines/types';
import { errorResponse } from '../../../../src/core/server/http-error';

const engine = (o: object): CustomEngine => customEngineSchema.parse({ name: 'Team', base: 'sglang', ...o });
const team = engine({ id: 'team', run: { mode: 'docker', image: 'team/sglang:v1' }, pulledImage: 'team/sglang:v1' });
const fusion = engine({ id: 'fusion', base: 'ninfer', run: { mode: 'ninfer', path: '/home/u/fusion', distro: 'Ubuntu' } });
const folder: CustomEngineFiles = { kind: 'folder', target: '/home/u/fusion', distro: 'Ubuntu', command: 'wsl -d Ubuntu -- rm -rf /home/u/fusion' };

function setup(initial: CustomEngine[], deps: Partial<CustomEnginesDeps> = {}) {
  let settings: Settings = settingsSchema.parse({ customEngines: initial });
  const store = {
    get: async () => settings,
    update: async (patch: Partial<Settings>) => {
      settings = settingsSchema.parse({ ...settings, ...patch });
      return settings;
    },
  };
  const app = new Hono();
  app.onError((e, c) => errorResponse(c, e));
  createCustomEngineRoutes({ settings: store, registry: new EngineRegistry([]), ...deps })(app, {} as CoreContext);
  const req = async (method: string, url: string, body?: unknown) => {
    const res = await app.request(url, { method, ...(body !== undefined ? { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } } : {}) });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  return { req, current: () => settings.customEngines };
}

describe('the delete routes', () => {
  it('without a files service: every engine is only forgotten', async () => {
    const s = setup([team]);
    expect((await s.req('GET', '/api/engines/custom/team/remove')).body).toEqual({ id: 'team' });
    expect((await s.req('DELETE', '/api/engines/custom/team?files=1')).body).toMatchObject({ error: { code: 'VALIDATION', params: { reason: 'no-files', id: 'team' } } });
    expect(s.current()).toHaveLength(1);
    expect((await s.req('GET', '/api/engines/custom/nope/remove')).body).toMatchObject({ error: { code: 'ENGINE_NOT_INSTALLED' } });
  });

  it('says what goes, removes it before forgetting the engine, and refuses while something runs', async () => {
    const remove = vi.fn(async () => undefined);
    let busy = true;
    const s = setup([team, fusion], { files: { plan: async (e) => (e.id === 'fusion' ? folder : undefined), remove }, busy: () => busy });
    expect((await s.req('GET', '/api/engines/custom/fusion/remove')).body).toEqual({ id: 'fusion', files: folder });
    const refused = await s.req('DELETE', '/api/engines/custom/fusion?files=1');
    expect(refused.body).toMatchObject({ error: { code: 'ENGINE_IN_USE', params: { engine: 'Team' } } });
    expect(remove).not.toHaveBeenCalled();
    busy = false;
    expect((await s.req('DELETE', '/api/engines/custom/fusion?files=1')).body).toEqual({ ok: true });
    expect(remove).toHaveBeenCalledWith(fusion, folder);
    expect(s.current().map((e) => e.id)).toEqual(['team']);
    // Forgotten only: its files stay.
    expect((await s.req('DELETE', '/api/engines/custom/team')).body).toEqual({ ok: true });
    expect(remove).toHaveBeenCalledTimes(1);
    expect(s.current()).toEqual([]);
  });

  it('an edit keeps the image LLM Bench pulled while the engine still runs it; a copy never owns it', async () => {
    const s = setup([team]);
    const draft = { name: 'Team 2', base: 'sglang', run: { mode: 'docker', image: 'team/sglang:v1' } };
    expect((await s.req('PUT', '/api/engines/custom/team', draft)).body).toMatchObject({ name: 'Team 2', pulledImage: 'team/sglang:v1' });
    const copy = (await s.req('POST', '/api/engines/custom/team/duplicate', {})).body;
    expect(copy).toMatchObject({ id: 'team-2-2' });
    expect(copy).not.toHaveProperty('pulledImage');
    expect((await s.req('PUT', '/api/engines/custom/team', { ...draft, run: { mode: 'docker', image: 'team/sglang:v2' } })).body).not.toHaveProperty('pulledImage');
    const plain = setup([engine({ id: 'p', run: { mode: 'docker', image: 'team/sglang:v1' } })]);
    expect((await plain.req('PUT', '/api/engines/custom/p', draft)).body).not.toHaveProperty('pulledImage');
  });
});

describe('what LLM Bench added for an engine', () => {
  const images = (have: Record<string, number>) => ({
    inspect: vi.fn(async (ref: string) => {
      if (ref === 'broken/x:1') throw new Error('docker down');
      return have[ref] === undefined ? undefined : { size: have[ref] };
    }),
    remove: vi.fn(async () => undefined),
  });
  const official = ['vllm/vllm-openai', 'lmsysorg/sglang', 'ghcr.io/ggml-org/llama.cpp'];

  it('the image it pulled, while it is there and no other engine runs it; never an official one or one the user pulled', async () => {
    const img = images({ 'team/sglang:v1': 9e9, 'lmsysorg/sglang:v0.5.21': 1, 'registry.local:5000/x@sha256:abc': 2 });
    const files = createCustomEngineFiles({ images: img, officialRepos: official });
    expect(await files.plan(team, [team])).toEqual({ kind: 'image', target: 'team/sglang:v1', sizeBytes: 9e9, command: 'docker rmi team/sglang:v1' });
    // Another saved engine runs the same image: it stays.
    const twin = engine({ id: 'twin', run: { mode: 'docker', image: 'team/sglang:v1' } });
    expect(await files.plan(team, [team, twin])).toBeUndefined();
    // The user's own image (not pulled by LLM Bench), an official repository, one removed by hand, Docker not answering.
    expect(await files.plan(engine({ id: 'u', run: { mode: 'docker', image: 'team/sglang:v1' } }), [])).toBeUndefined();
    const own = (image: string) => engine({ id: 'o', run: { mode: 'docker', image }, pulledImage: image });
    expect(await files.plan(own('lmsysorg/sglang:v0.5.21'), [])).toBeUndefined();
    expect(await files.plan(own('gone/x:1'), [])).toBeUndefined();
    expect(await files.plan(own('broken/x:1'), [])).toBeUndefined();
    // A registry with a port and a digest: its repository read right.
    expect(await files.plan(own('registry.local:5000/x@sha256:abc'), [])).toMatchObject({ kind: 'image', sizeBytes: 2 });
    // Not a Docker or NInfer engine: nothing of LLM Bench's.
    expect(await files.plan(engine({ id: 'n', base: 'llamacpp', run: { mode: 'native', path: '/x/llama-server' } }), [])).toBeUndefined();
    await files.remove(team, { kind: 'image', target: 'team/sglang:v1', command: '' });
    expect(img.remove).toHaveBeenCalledWith('team/sglang:v1');
    // No Docker at all.
    expect(await createCustomEngineFiles({ officialRepos: official }).plan(team, [team])).toBeUndefined();
  });

  it('the checkout it built for a NInfer variant, unless another engine runs from it', async () => {
    const ninfer = { files: vi.fn(async () => folder), remove: vi.fn(async () => undefined) };
    const files = createCustomEngineFiles({ ninfer, officialRepos: [] });
    expect(await files.plan(fusion, [fusion])).toEqual(folder);
    const same = engine({ id: 'same', base: 'ninfer', run: { mode: 'ninfer', path: '/home/u/fusion/build/apps/ninfer-serve', distro: 'Ubuntu' } });
    expect(await files.plan(fusion, [fusion, same, team])).toBeUndefined();
    // The same folder in another distro is another folder.
    const elsewhere = engine({ id: 'else', base: 'ninfer', run: { mode: 'ninfer', path: '/home/u/fusion' } });
    expect(await files.plan(fusion, [fusion, elsewhere])).toEqual(folder);
    ninfer.files.mockResolvedValueOnce(undefined as never);
    expect(await files.plan(fusion, [fusion])).toBeUndefined();
    await files.remove(fusion, folder);
    expect(ninfer.remove).toHaveBeenCalledWith(fusion, folder);
    // No NInfer service: nothing.
    expect(await createCustomEngineFiles({ officialRepos: [] }).plan(fusion, [fusion])).toBeUndefined();
    // A variant without a distro.
    const local = engine({ id: 'local', base: 'ninfer', run: { mode: 'ninfer', path: '/home/u/l' } });
    ninfer.files.mockResolvedValueOnce({ kind: 'folder', target: '/home/u/l', command: 'rm -rf /home/u/l' });
    expect(await files.plan(local, [local, fusion])).toMatchObject({ target: '/home/u/l' });
  });
});

describe('an image pulled for a custom engine', () => {
  function dockerAdapter(installed: boolean, data: Record<string, unknown> = { image: 'team/sglang:v1' }): EngineAdapter {
    return {
      kind: 'sglang-docker',
      detect: async (): Promise<EngineStatus> => ({ kind: 'sglang-docker', available: installed, installed, problems: [], supported: true }),
      capabilities: async () => ({ flags: new Set(), tokenIdsInPrompt: true, timings: true, minTokens: false, fitFlag: false }),
      plan: async () => {
        throw new Error('not here');
      },
      start: async () => {
        throw new Error('not here');
      },
      installPlan: async () => ({ kind: 'sglang-docker', label: 'x', bytes: 0, items: [], data }),
      install: async () => undefined,
    };
  }
  const run = async (a: EngineAdapter, list: CustomEngine[], pulled?: (id: string, image: string) => Promise<void>, cfg: object = { kind: 'sglang-docker', customEngineId: 'team' }) => {
    const wrapped = withCustomEngines([a], { list: async () => list, ...(pulled ? { pulled } : {}) })[0]!;
    const plan = (await wrapped.installPlan!(cfg as never)) as InstallPlan;
    await wrapped.install!(plan, () => undefined, new AbortController().signal);
    return plan;
  };

  it('is remembered as LLM Bench’s only when the PC did not have it', async () => {
    const pulled = vi.fn(async () => undefined);
    const plain = engine({ id: 'team', run: { mode: 'docker', image: 'team/sglang:v1' } });
    expect((await run(dockerAdapter(false), [plain], pulled)).data).toEqual({ image: 'team/sglang:v1', pulledFor: 'team' });
    expect(pulled).toHaveBeenCalledWith('team', 'team/sglang:v1');
    pulled.mockClear();
    // Already there (the user's own), not a custom engine, not a Docker one: nothing remembered.
    expect((await run(dockerAdapter(true), [plain], pulled)).data).toEqual({ image: 'team/sglang:v1' });
    await run(dockerAdapter(false), [plain], pulled, { kind: 'sglang-docker' });
    const native = engine({ id: 'team', run: { mode: 'native', path: '/x/python' } });
    await run(dockerAdapter(false), [native], pulled, { kind: 'sglang-native', customEngineId: 'team' });
    expect(pulled).not.toHaveBeenCalled();
    // A plan without its image, or a source that keeps nothing: no harm.
    await run(dockerAdapter(false, {}), [plain], pulled);
    expect(pulled).not.toHaveBeenCalled();
    await run(dockerAdapter(false), [plain]);
  });
});
