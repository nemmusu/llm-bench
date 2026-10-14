/** NInfer's update: the check's parsing and the update's edge cases, with a scripted builder (no processes). */
import { afterAll, describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { AppError } from '../../../../../src/contract/errors';
import type { LocalModel } from '../../../../../src/contract/models';
import type { RunOutput } from '../../../../../src/core/deps';
import { NinferUpdater, parseUpdate, reportStale } from '../../../../../src/core/engines/ninfer/update';
import { ok, tempDir } from '../../docker/helpers';
import { ninferModel } from './helpers';

const cleanups: (() => void)[] = [];
afterAll(() => {
  for (const c of cleanups) c();
});

const HEAD = 'e31bc99b13f517c8aae70b997b7c4a49b4dcdc5d';
const NEXT = '4f2a9c1d0e8b7a6f5e4d3c2b1a0f9e8d7c6b5a49';

describe('the update check output', () => {
  it('reads what is there and skips what is not', () => {
    const lines = ['noise', '##dir ', '##head nothex', '##branch ', '##latest also-not', '##counts ', '##commit zz title', '##dirty ', '##tool tools/other.py', '##upstream ', '##fetcherr ', '##cmake ', '##built nothex', '##headtime ', '##servetime 0'];
    expect(parseUpdate(lines.join('\n'))).toEqual({ git: true, ahead: 0, behind: 0, commits: [], dirty: [], tools: [], cmake: false });
    expect(parseUpdate(`##dir /n\n##counts 2\n##fetched no\n##fetcherr fatal: no\n##fetcherr network\n##cmake /usr/bin/cmake\n`)).toMatchObject({ dir: '/n', ahead: 2, behind: 0, fetched: false, fetchError: 'fatal: no\nnetwork', cmake: true });
    expect(parseUpdate(`##dir /n\n##fetched yes\n##built ${HEAD}\n##headtime 1760000000\n##servetime 1760000100\n`)).toMatchObject({ fetched: true, built: HEAD, headTime: 1_760_000_000, serveTime: 1_760_000_100 });
    expect(parseUpdate(`##dir /n\n##commit ${NEXT}\n##nocheckout\n`)).toEqual({ git: true, ahead: 0, behind: 0, commits: [], dirty: [], tools: [], cmake: false });
    expect(parseUpdate('##nogit\n').git).toBe(false);
  });

  it('a program older than its code: built from another commit, or (no record) before the last commit', () => {
    expect(reportStale({ head: HEAD, built: HEAD })).toBe(false);
    expect(reportStale({ head: NEXT, built: HEAD })).toBe(true);
    expect(reportStale({ built: HEAD })).toBe(false);
    expect(reportStale({ head: HEAD, headTime: 20, serveTime: 10 })).toBe(true);
    expect(reportStale({ head: HEAD, headTime: 10, serveTime: 20 })).toBe(false);
    expect(reportStale({ head: HEAD, headTime: 20 })).toBe(false);
    expect(reportStale({ head: HEAD, serveTime: 20 })).toBe(false);
  });
});

type Step = (stage: string, argv: string[]) => Promise<void>;

function updater(
  o: { out?: string; models?: () => Promise<LocalModel[]>; distro?: string; repo?: string; script?: (script: string, args: string[]) => RunOutput | Promise<RunOutput>; step?: Step; verify?: boolean } = {},
) {
  const ran: string[] = [];
  const builder = {
    runner: () => async (_cmd: string, args: string[]) => {
      const script = args[1] as string;
      if (script.includes('##nocheckout')) return ok(o.out ?? '');
      ran.push(script.includes('kept') ? 'keep' : script.includes('dropped') ? 'drop' : 'restore');
      return o.script ? o.script(script, args) : ok(script.includes('kept') ? '##gpubench-kept\n' : script.includes('restored') ? '##gpubench-restored\n' : '##gpubench-dropped\n');
    },
    step: async (stage: string, argv: string[], _distro: string | undefined, progress: (p: { stage: string; bytesDone: number; bytesTotal?: number }) => void) => {
      ran.push(stage);
      progress({ stage, bytesDone: 1, bytesTotal: 4 });
      progress({ stage, bytesDone: 0 });
      await o.step?.(stage, argv);
    },
    record: async () => {
      ran.push('record');
      return true;
    },
    // A failure's log (the real one writes a file): its path in the error.
    withLog: async (e: unknown) => (e instanceof AppError && e.code !== 'CANCELLED' ? new AppError(e.code, e.message, { params: { ...e.params, log: '/logs/x.log' }, ...(e.detail ? { detail: e.detail } : {}) }) : e),
  } as unknown as ConstructorParameters<typeof NinferUpdater>[0]['builder'];
  const u = new NinferUpdater({
    kind: o.distro ? 'ninfer-wsl' : 'ninfer-native',
    builder,
    where: async () => ({ serve: '/n/build/apps/ninfer-serve', ...(o.repo !== undefined ? (o.repo ? { repo: o.repo } : {}) : { repo: '/n' }), ...(o.distro ? { distro: o.distro } : {}) }),
    models: o.models ?? (async () => []),
    verify: async () => o.verify !== false,
    clock: { wall: () => 0 },
  });
  const events: { stage: string; step?: number; steps?: number }[] = [];
  return { u, ran, events, run: () => u.update((p) => events.push(p), new AbortController().signal) };
}

const behind = `##dir /n\n##head ${HEAD}\n##branch master\n##upstream origin/master\n##latest ${NEXT}\n##counts 0\t1\n##commit ${NEXT} next\n##cmake /usr/bin/cmake\n`;

describe('updates of a native build', () => {
  it('lists older artifacts without a command when there is no tool, or the file is out of the distro\'s reach', async () => {
    const t = tempDir('gb-ninfer-upd-');
    cleanups.push(t.cleanup);
    const a = ninferModel(path.join(t.dir, 'a'));
    const manifest = a.local.paths[1] as string;
    writeFileSync(manifest, JSON.stringify({ artifact: { container_version: 1, name: 'qwen3.8-27b', components: [] } }));
    const noManifest = ninferModel(path.join(t.dir, 'b'), { manifest: false });
    const incomplete = { ...a.local, id: 'x', incomplete: { missing: ['a'] } } as unknown as LocalModel;
    const gguf = { ...a.local, id: 'g', identity: { ...a.local.identity, format: 'gguf' } } as LocalModel;
    const noFile = { ...a.local, id: 'nf', paths: [manifest] };
    const tools = '##dir /n\n##tool tools/upgrade_ninfer_v2_to_v3.py\n';
    const { u } = updater({ out: tools, models: async () => [a.local, noManifest.local, incomplete, gguf, noFile] });
    expect((await u.plan()).check.ninfer).toEqual({ containerVersion: 3, artifacts: [{ id: 'n1', name: 'qwen3_8_27b_nvfp4', file: a.local.paths[0], version: 1, needs: 3 }] });
    // In WSL a file of another distro has no path there: no command.
    writeFileSync(manifest, JSON.stringify({ artifact: { container_version: 2, name: 'qwen3.8-27b', components: [] } }));
    const other = { ...a.local, paths: ['\\\\wsl.localhost\\Debian\\m.ninfer', manifest] };
    const wsl = updater({ out: tools, distro: 'Ubuntu', models: async () => [other] });
    expect((await wsl.u.plan()).check).toMatchObject({ distro: 'Ubuntu', ninfer: { artifacts: [{ id: 'n1', file: '\\\\wsl.localhost\\Debian\\m.ninfer', version: 2, needs: 3 }] } });
    // A library that cannot be read: none; no tools: the container version LLM Bench knows.
    expect((await updater({ out: '##dir /n\n', models: () => Promise.reject(new Error('scan')) }).u.plan()).check.ninfer).toEqual({ containerVersion: 3, artifacts: [] });
  });

  it('a fetch that failed without a word is still said', async () => {
    const out = `##dir /n\n##fetched no\n##head ${HEAD}\n##branch master\n##upstream origin/master\n##latest ${HEAD}\n##counts 0\t0\n`;
    const { check } = await updater({ out }).u.plan({ fetch: true });
    expect(check).toMatchObject({ state: 'blocked', reason: 'fetch-failed' });
    expect(check).not.toHaveProperty('detail');
  });

  it('starts from the program\'s folder when the build is not in the usual place', async () => {
    expect((await updater({ out: '##nocheckout\n', repo: '' }).u.plan()).check).toMatchObject({ target: 'ninfer-native', method: 'none', state: 'none', reason: 'tools' });
  });

  it('runs the steps with their progress as steps, records the commit built, and checks the rebuilt program', async () => {
    const r = updater({ out: behind });
    expect(await r.run()).toEqual({ version: '4f2a9c1' });
    expect(r.ran).toEqual(['keep', 'git-pull', 'build', 'drop', 'record']);
    expect(r.events).toEqual([
      { stage: 'git-pull', bytesDone: 0, step: 1, steps: 4 },
      { stage: 'git-pull', bytesDone: 0 },
      { stage: 'build', bytesDone: 0, step: 1, steps: 4 },
      { stage: 'build', bytesDone: 0 },
      { stage: 'verify', bytesDone: 0 },
    ]);
    await expect(updater({ out: behind, verify: false }).run()).rejects.toMatchObject({ code: 'ENGINE_UPDATE_FAILED', params: { reason: 'verify' } });
  });

  it('a pull failure goes on even if the copy cannot go; a cancel stays a cancel', async () => {
    const pull = updater({
      out: behind,
      script: (s) => (s.includes('dropped') ? Promise.reject(new Error('gone')) : ok('##gpubench-kept\n')),
      step: async (stage) => {
        if (stage === 'git-pull') throw new Error('network');
      },
    });
    await expect(pull.run()).rejects.toMatchObject({ code: 'ENGINE_UPDATE_FAILED', message: 'Error: network', params: { reason: 'git' } });
    expect(pull.ran).toEqual(['keep', 'git-pull', 'drop']);
    // A step's own failure keeps its params, and gets the path of its log.
    const refused = updater({
      out: behind,
      step: async (stage) => {
        if (stage === 'git-pull') throw new AppError('ENGINE_INSTALL_FAILED', 'NInfer git-pull failed', { params: { stage: 'git-pull', reading: 'local-changes' }, detail: 'Please commit your changes' });
      },
    });
    await expect(refused.run()).rejects.toMatchObject({ code: 'ENGINE_UPDATE_FAILED', detail: 'Please commit your changes', params: { reason: 'git', stage: 'git-pull', reading: 'local-changes', log: '/logs/x.log' } });
    const cancelled = updater({
      out: behind,
      step: async (stage) => {
        if (stage === 'build') throw new AppError('CANCELLED', 'Build cancelled');
      },
    });
    await expect(cancelled.run()).rejects.toMatchObject({ code: 'CANCELLED', params: { reason: 'cmake', restored: true } });
  });

  it('says when the previous build could not be put back', async () => {
    const failBuild: Step = async (stage) => {
      if (stage === 'build') throw new AppError('ENGINE_INSTALL_FAILED', 'NInfer build failed');
    };
    const r = updater({ out: behind, script: (s) => (s.includes('restored') ? ok('mv: cannot move') : ok('##gpubench-kept\n')), step: failBuild });
    await expect(r.run()).rejects.toMatchObject({ code: 'ENGINE_UPDATE_FAILED', params: { reason: 'cmake', restored: false, commit: HEAD.slice(0, 7) } });
    const gone = updater({ out: behind, script: (s) => (s.includes('restored') ? Promise.reject(new Error('wsl')) : ok('##gpubench-kept\n')), step: failBuild });
    await expect(gone.run()).rejects.toMatchObject({ params: { restored: false } });
  });

  it('the newest code but an older program: a rebuild, without a pull and without any reset', async () => {
    const stale = `##dir /n\n##head ${HEAD}\n##branch master\n##upstream origin/master\n##latest ${HEAD}\n##counts 0\t0\n##cmake /usr/bin/cmake\n##built ${NEXT}\n`;
    const r = updater({ out: stale });
    const { check } = await r.u.plan();
    expect(check).toMatchObject({ state: 'available', stale: true, built: NEXT.slice(0, 7), commits: 0 });
    expect(check.commands.map((c) => c[0])).toEqual(['cp', 'cmake', 'git']);
    expect(check.restore).toEqual([['mv', '-f', '/n/build/apps/ninfer-serve.gpubench-previous', '/n/build/apps/ninfer-serve']]);
    expect(await r.run()).toEqual({ version: HEAD.slice(0, 7) });
    expect(r.ran).toEqual(['keep', 'build', 'drop', 'record']);
    // A failed rebuild puts the program back and leaves the checkout alone (no commit to go back to).
    const scripts: string[][] = [];
    const failed = updater({
      out: stale,
      script: (s, args) => {
        scripts.push(args);
        return ok(s.includes('restored') ? '##gpubench-restored\n' : '##gpubench-kept\n');
      },
      step: async () => {
        throw new AppError('ENGINE_INSTALL_FAILED', 'NInfer build failed');
      },
    });
    await expect(failed.run()).rejects.toMatchObject({ params: { reason: 'cmake', restored: true } });
    expect(scripts.at(-1)?.slice(-3)).toEqual(['/n/build/apps/ninfer-serve', '/n', '']);
    // Older by its time (built by hand, no record); without cmake it says so.
    const byTime = `##dir /n\n##head ${HEAD}\n##branch master\n##upstream origin/master\n##counts 0\t0\n##headtime 20\n##servetime 10\n`;
    expect((await updater({ out: byTime }).u.plan()).check).toMatchObject({ state: 'blocked', reason: 'cmake-missing', stale: true, commits: 0 });
  });
});
