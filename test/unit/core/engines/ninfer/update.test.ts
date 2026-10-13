/** The update's parsing and its edge cases, with a scripted builder (no processes). */
import { afterAll, describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import type { LocalModel } from '../../../../../src/contract/models';
import type { RunOutput } from '../../../../../src/core/deps';
import { NinferUpdater, parseUpdate } from '../../../../../src/core/engines/ninfer/update';
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
    expect(parseUpdate(['noise', '##dir ', '##head nothex', '##latest also-not', '##counts ', '##commit zz title', '##dirty ', '##tool tools/other.py', '##upstream '].join('\n'))).toEqual({
      fetched: false,
      ahead: 0,
      behind: 0,
      commits: [],
      dirty: [],
      tools: [],
    });
    expect(parseUpdate(`##dir /n\n##counts 2\n##fetched no\n`)).toMatchObject({ dir: '/n', ahead: 2, behind: 0, fetched: false });
    expect(parseUpdate(`##dir /n\n##commit ${NEXT}\n##nocheckout\n`)).toEqual({ fetched: false, ahead: 0, behind: 0, commits: [], dirty: [], tools: [] });
  });
});

type Step = (stage: string, argv: string[]) => Promise<void>;

function updater(o: { out?: string; models?: () => Promise<LocalModel[]>; distro?: string; repo?: string; script?: (script: string, args: string[]) => RunOutput | Promise<RunOutput>; step?: Step } = {}) {
  const ran: string[] = [];
  const builder = {
    runner: () => async (_cmd: string, args: string[]) => {
      const script = args[1] as string;
      if (script.includes('##nocheckout')) return ok(o.out ?? '');
      ran.push(script.includes('kept') ? 'keep' : script.includes('dropped') ? 'drop' : 'restore');
      return o.script ? o.script(script, args) : ok(script.includes('kept') ? '##gpubench-kept\n' : script.includes('restored') ? '##gpubench-restored\n' : '##gpubench-dropped\n');
    },
    step: async (stage: string, argv: string[]) => {
      ran.push(stage);
      await o.step?.(stage, argv);
    },
  } as unknown as ConstructorParameters<typeof NinferUpdater>[0]['builder'];
  const u = new NinferUpdater({
    kind: o.distro ? 'ninfer-wsl' : 'ninfer-native',
    builder,
    where: async () => ({ serve: '/n/build/apps/ninfer-serve', ...(o.repo !== undefined ? (o.repo ? { repo: o.repo } : {}) : { repo: '/n' }), ...(o.distro ? { distro: o.distro } : {}) }),
    models: o.models ?? (async () => []),
  });
  const progress = () => undefined;
  return { u, ran, run: () => u.update(progress, new AbortController().signal) };
}

const behind = `##dir /n\n##fetched yes\n##head ${HEAD}\n##counts 0\t1\n##commit ${NEXT} next\n`;

describe('updates of a native build', () => {
  it('lists older artifacts without a command when there is no tool, or the file is out of the distro\'s reach', async () => {
    const t = tempDir('gb-ninfer-upd-');
    cleanups.push(t.cleanup);
    const v2 = (dir: string) => {
      const m = ninferModel(path.join(t.dir, dir));
      const manifest = m.local.paths[1] as string;
      return { m, manifest };
    };
    const a = v2('a');
    writeFileSync(a.manifest, JSON.stringify({ artifact: { container_version: 1, name: 'qwen3.8-27b', components: [] } }));
    const noManifest = ninferModel(path.join(t.dir, 'b'), { manifest: false });
    const incomplete = { ...a.m.local, id: 'x', incomplete: { missing: ['a'] } } as unknown as LocalModel;
    const gguf = { ...a.m.local, id: 'g', identity: { ...a.m.local.identity, format: 'gguf' } } as LocalModel;
    const { u } = updater({ out: `##dir /n\n##tool tools/upgrade_ninfer_v2_to_v3.py\n`, models: async () => [a.m.local, noManifest.local, incomplete, gguf] });
    expect((await u.status()).artifacts).toEqual([{ id: 'n1', name: 'qwen3_8_27b_nvfp4', file: a.m.local.paths[0], version: 1, needs: 3 }]);
    // In WSL a file of another distro has no path there: no command.
    const other = { ...a.m.local, paths: ['\\\\wsl.localhost\\Debian\\m.ninfer', a.manifest] };
    writeFileSync(a.manifest, JSON.stringify({ artifact: { container_version: 2, name: 'qwen3.8-27b', components: [] } }));
    const wsl = updater({ out: `##dir /n\n##tool tools/upgrade_ninfer_v2_to_v3.py\n`, distro: 'Ubuntu', models: async () => [other] });
    expect((await wsl.u.status()).artifacts).toEqual([{ id: 'n1', name: 'qwen3_8_27b_nvfp4', file: '\\\\wsl.localhost\\Debian\\m.ninfer', version: 2, needs: 3 }]);
    // A library entry without its .ninfer file is skipped.
    const noFile = { ...a.m.local, paths: [a.manifest] };
    expect((await updater({ out: '##dir /n\n', models: async () => [noFile] }).u.status()).artifacts).toEqual([]);
    // A library that cannot be read: none.
    expect((await updater({ out: '##dir /n\n', models: () => Promise.reject(new Error('scan')) }).u.status()).artifacts).toEqual([]);
  });

  it('starts from the program\'s folder when the build is not in the usual place', async () => {
    const { u } = updater({ out: '##nocheckout\n', repo: '' });
    expect(await u.status()).toMatchObject({ kind: 'ninfer-native', updatable: false, behind: 0, containerVersion: 3 });
  });

  it('an up-to-date checkout without a HEAD says no commit; a pull failure keeps going even if the copy cannot go', async () => {
    expect(await updater({ out: '##dir /n\n##counts 0\t0\n' }).run()).toEqual({ serve: '/n/build/apps/ninfer-serve' });
    const pull = updater({
      out: behind,
      script: (s) => (s.includes('dropped') ? Promise.reject(new Error('gone')) : ok('##gpubench-kept\n')),
      step: async (stage) => {
        if (stage === 'pull') throw new Error('network');
      },
    });
    await expect(pull.run()).rejects.toThrow('network');
    expect(pull.ran).toEqual(['keep', 'pull', 'drop']);
  });

  it('says when the previous build could not be put back, and wraps unexpected failures', async () => {
    const r = updater({
      out: behind,
      script: (s) => (s.includes('restored') ? ok('mv: cannot move') : ok('##gpubench-kept\n')),
      step: async (stage) => {
        if (stage === 'build') throw new Error('ninja crashed');
      },
    });
    await expect(r.run()).rejects.toMatchObject({ code: 'ENGINE_INSTALL_FAILED', message: 'Error: ninja crashed', params: { reason: 'ninfer_update', restored: false, commit: HEAD.slice(0, 12) } });
    const gone = updater({
      out: behind,
      script: (s) => (s.includes('restored') ? Promise.reject(new Error('wsl')) : ok('##gpubench-kept\n')),
      step: async (stage) => {
        if (stage === 'build') throw new Error('x');
      },
    });
    await expect(gone.run()).rejects.toMatchObject({ params: { restored: false } });
    // Success without an upstream head to report.
    expect(await updater({ out: `##dir /n\n##head ${HEAD}\n##counts 0\t1\n` }).run()).toEqual({ serve: '/n/build/apps/ninfer-serve' });
  });
});
