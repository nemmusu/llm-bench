/**
 * The pieces of NInfer variants that need no process: what a --help says about --kv-dtype, the build's
 * repository, its size and its time, where a variant's build is saved, a variant's engine config.
 */
import { describe, expect, it } from 'vitest';
import type { CustomEngine } from '../../../../../src/contract/custom-engines';
import { customEngineTemplate } from '../../../../../src/contract/custom-engines';
import { expandCustom } from '../../../../../src/core/engines/custom/adapter';
import { kvDtypesOfHelp } from '../../../../../src/core/engines/ninfer/adapter';
import { buildMinutes, buildSteps, githubRepoOf, NinferBuilder, parsePrereqs, sameRepo } from '../../../../../src/core/engines/ninfer/build';
import { withVariantBuild } from '../../../../../src/core/engines/ninfer/routes';
import { summaryOf } from '../../../../../src/core/store/runs-repo';
import { ok, scriptedProc } from '../../docker/helpers';
import { makeRun } from '../../store/fixtures';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { NINFER_FIXTURES } from './helpers';

const ALL = { url: 'https://github.com/iamwavecut/ninfer-all.git', branch: 'master' };

describe('the KV types a build lists', () => {
  it('the official usage line, NInfer-all\'s option table, nothing to read', () => {
    expect(kvDtypesOfHelp(readFileSync(path.join(NINFER_FIXTURES, 'help.stdout.txt'), 'utf8'))).toEqual(['bf16', 'int8', 'fp8', 'nvfp4', 'k8v4']);
    expect(kvDtypesOfHelp(readFileSync(path.join(NINFER_FIXTURES, 'help-all.stdout.txt'), 'utf8'))).toEqual(['bf16', 'int8', 'fp8', 'rk8v4', 'rk4v4', 'rk4v4-e8', 'rk2v4-e8', 'nvfp4', 'k8v4']);
    expect(kvDtypesOfHelp('usage: ninfer-serve <model> [--host H]')).toBeUndefined();
    expect(kvDtypesOfHelp('  --kv-dtype T   the KV storage')).toBeUndefined();
  });
});

describe('the build of a variant', () => {
  it('its repository, its branch, its size and its time', () => {
    expect(buildSteps('/home/u/ninfer-all', { existing: false, source: ALL })[0]?.argv).toEqual(['git', 'clone', '--progress', '--branch', 'master', ALL.url, '/home/u/ninfer-all']);
    expect(sameRepo('https://GitHub.com/iamwavecut/ninfer-all/', 'https://github.com/iamwavecut/ninfer-all.git')).toBe(true);
    expect(sameRepo('https://github.com/Neroued/ninfer.git', ALL.url)).toBe(false);
    expect(githubRepoOf(ALL.url)).toBe('iamwavecut/ninfer-all');
    expect(githubRepoOf('https://gitlab.com/me/ninfer-fork.git')).toBeUndefined();
    expect(buildMinutes(16)).toBe(10);
    expect(buildMinutes(undefined)).toBe(20);
    expect(buildMinutes(128)).toBe(3);
    // The cores and the checkout's origin, when the script says them.
    expect(parsePrereqs('##home /h\n##cpus 24\n##origin https://x/y.git\n')).toMatchObject({ cpus: 24, origin: 'https://x/y.git' });
    expect(parsePrereqs('##home /h\n##cpus \n##origin \n')).not.toHaveProperty('cpus');
    expect(parsePrereqs('##home /h\n##cpus 0\n')).not.toHaveProperty('origin');
  });

  it('what the clone downloads: asked once, never a reason not to build', async () => {
    const lines = ['##home /home/user', '##git git version 2.43.0', '##cmake cmake version 3.28.3', '##ninja 1.11.1', '##compiler g++ 13.3.0', '##pkg-config 1.8.1', '##cuda Cuda compilation tools, release 13.1, V13.1.80', '##ffmpeg 1 2 3 4', '##curl 8.5.0', '##checkout '].join('\n');
    const proc = scriptedProc(() => ok(lines));
    const asked: string[] = [];
    const sized = new NinferBuilder({ kind: 'ninfer-native', proc, newMarker: () => 'm', repoBytes: async (repo) => (asked.push(repo), 1000) });
    expect(await sized.plan({ kind: 'ninfer-native', source: ALL })).toMatchObject({ downloadBytes: 1000, minutes: 20, ready: true, dir: '/home/user/ninfer' });
    expect(asked).toEqual(['iamwavecut/ninfer-all']);
    const failing = new NinferBuilder({ kind: 'ninfer-native', proc, newMarker: () => 'm', repoBytes: async () => Promise.reject(new Error('offline')) });
    expect(await failing.plan({ kind: 'ninfer-native', dir: '/opt/x' })).not.toHaveProperty('downloadBytes');
    // Not on GitHub: nothing asked.
    expect(await sized.plan({ kind: 'ninfer-native', source: { url: 'https://gitlab.com/me/ninfer-fork.git' } })).not.toHaveProperty('downloadBytes');
    expect(asked).toEqual(['iamwavecut/ninfer-all']);
  });
});

describe('where a variant\'s build is saved', () => {
  const where = { path: '/home/u/ninfer-all/build/apps/ninfer-serve', distro: 'Ubuntu-24.04' };
  const mine: CustomEngine = {
    schema: 1,
    id: 'mine',
    name: 'Mine',
    base: 'ninfer',
    run: { mode: 'ninfer', path: '/old' },
    extraArgs: ['--vision-cpu'],
    env: {},
    notes: 'keep me',
  };

  it('a new engine from the template, with its rules; or a new one of its own name', () => {
    const made = withVariantBuild([mine], { template: 'ninfer-all', name: 'NInfer-all' }, where, ALL);
    expect(made.id).toBe('ninfer-all');
    expect(made.engines[1]).toMatchObject({ id: 'ninfer-all', template: 'ninfer-all', match: customEngineTemplate('ninfer-all')?.match, run: { mode: 'ninfer', ...where, source: ALL } });
    const plain = withVariantBuild([], { name: 'Fusion KV' }, { path: '/opt/f/build/apps/ninfer-serve' }, undefined);
    expect(plain.engines[0]).toEqual(expect.objectContaining({ id: 'fusion-kv', name: 'Fusion KV', run: { mode: 'ninfer', path: '/opt/f/build/apps/ninfer-serve' } }));
    expect(plain.engines[0]).not.toHaveProperty('template');
  });

  it('an existing engine (by id, else made from the template) gets the new build, the rest kept', () => {
    const other: CustomEngine = { ...mine, id: 'other', name: 'Other' };
    const byId = withVariantBuild([other, mine], { id: 'mine', name: 'ignored' }, where, ALL);
    expect(byId).toMatchObject({ id: 'mine', engines: [other, { id: 'mine', name: 'Mine', extraArgs: ['--vision-cpu'], notes: 'keep me', run: { mode: 'ninfer', ...where, source: ALL } }] });
    const fromTemplate = withVariantBuild([{ ...mine, template: 'ninfer-all' }], { id: 'gone', template: 'ninfer-all', name: 'NInfer-all' }, where, ALL);
    expect(fromTemplate.id).toBe('mine');
    expect(fromTemplate.engines).toHaveLength(1);
  });

  it('a variant\'s engine config names its build and its distro', () => {
    expect(expandCustom({ ...mine, run: { mode: 'ninfer', path: '/opt/x' } }, { kind: 'ninfer-native', customEngineId: 'mine' })).toEqual({ kind: 'ninfer-native', customEngineId: 'mine', ninferPath: '/opt/x' });
    expect(expandCustom({ ...mine, run: { mode: 'ninfer', path: '/x', distro: 'Debian' } }, { kind: 'ninfer-wsl' })).toMatchObject({ ninferPath: '/x', wslDistro: 'Debian' });
  });
});

describe('the run list remembers what an engine could not read', () => {
  it('unreadable: the format of an ENGINE_MODEL_UNSUPPORTED failure', () => {
    const failed = makeRun({ status: 'failed', error: { code: 'ENGINE_MODEL_UNSUPPORTED', message: 'x', params: { engine: 'NInfer', reason: 'layout', value: 'gguf_blocks_v1' } } });
    expect(summaryOf(failed, 'f.json').unreadable).toBe('gguf_blocks_v1');
    expect(summaryOf(makeRun({ status: 'failed', error: { code: 'ENGINE_MODEL_UNSUPPORTED', message: 'x' } }), 'f.json')).not.toHaveProperty('unreadable');
    expect(summaryOf(makeRun({ status: 'failed', error: { code: 'ENGINE_EXITED', message: 'x', params: { value: 'v' } } }), 'f.json')).not.toHaveProperty('unreadable');
  });
});
