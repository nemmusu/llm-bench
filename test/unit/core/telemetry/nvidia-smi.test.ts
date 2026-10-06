import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { AppError } from '../../../../src/contract/errors';
import { initialChoice, type FieldSpec } from '../../../../src/core/telemetry/fields';
import {
  NvidiaSmiCli,
  classifyFailure,
  defaultFileExists,
  envGet,
  locateNvidiaSmi,
  nvidiaSmiCandidates,
  parseDriverInfo,
  type NvidiaSmiLocation,
} from '../../../../src/core/telemetry/nvidia-smi';
import { FakeRunner, fixture, ok } from './fakes';

const existsOnly =
  (...paths: string[]) =>
  (p: string) =>
    Promise.resolve(paths.includes(p));

describe('locateNvidiaSmi', () => {
  it('uses the endpoint override as an argv prefix without touching the disk', async () => {
    const loc = await locateNvidiaSmi({
      platform: 'win32',
      env: {},
      override: ['node', 'fake-nvidia-smi.mjs'],
      fileExists: () => Promise.reject(new Error('must not be called')),
    });
    expect(loc).toEqual({ argv: ['node', 'fake-nvidia-smi.mjs'], path: 'node fake-nvidia-smi.mjs', source: 'override' });
  });

  it('ignores an empty override and finds nvidia-smi.exe on a case-insensitive Windows PATH', async () => {
    const env = { Path: 'C:\\Tools;"C:\\WINDOWS\\system32";;' };
    const loc = await locateNvidiaSmi({ platform: 'win32', env, override: [], fileExists: existsOnly('C:\\WINDOWS\\system32\\nvidia-smi.exe') });
    expect(loc).toEqual({ argv: ['C:\\WINDOWS\\system32\\nvidia-smi.exe'], path: 'C:\\WINDOWS\\system32\\nvidia-smi.exe', source: 'path' });
  });

  it('falls back to the known Windows locations (System32, NVSMI)', async () => {
    expect(nvidiaSmiCandidates('win32', {}).map((c) => c.path)).toEqual([
      'C:\\Windows\\System32\\nvidia-smi.exe',
      'C:\\Program Files\\NVIDIA Corporation\\NVSMI\\nvidia-smi.exe',
    ]);
    const env = { SYSTEMROOT: 'D:\\Win', ProgramFiles: 'D:\\PF' };
    const loc = await locateNvidiaSmi({ platform: 'win32', env, fileExists: existsOnly('D:\\PF\\NVIDIA Corporation\\NVSMI\\nvidia-smi.exe') });
    expect(loc).toMatchObject({ path: 'D:\\PF\\NVIDIA Corporation\\NVSMI\\nvidia-smi.exe', source: 'known' });
  });

  it('finds nvidia-smi on a Linux PATH, else /usr/bin, else the WSL driver dir', async () => {
    const env = { PATH: '/usr/local/bin:/opt/x', Path: 'ignored on linux' };
    expect(nvidiaSmiCandidates('linux', env).map((c) => c.path)).toEqual([
      '/usr/local/bin/nvidia-smi',
      '/opt/x/nvidia-smi',
      '/usr/bin/nvidia-smi',
      '/usr/lib/wsl/lib/nvidia-smi',
    ]);
    expect(await locateNvidiaSmi({ platform: 'linux', env, fileExists: existsOnly('/opt/x/nvidia-smi') })).toMatchObject({ source: 'path' });
    expect(await locateNvidiaSmi({ platform: 'linux', env: {}, fileExists: existsOnly('/usr/lib/wsl/lib/nvidia-smi') })).toEqual({
      argv: ['/usr/lib/wsl/lib/nvidia-smi'],
      path: '/usr/lib/wsl/lib/nvidia-smi',
      source: 'known',
    });
  });

  it('returns undefined when nothing exists, and on macOS only searches PATH', async () => {
    expect(await locateNvidiaSmi({ platform: 'linux', env: {}, fileExists: existsOnly() })).toBeUndefined();
    expect(nvidiaSmiCandidates('darwin', { PATH: '/usr/bin' }).map((c) => c.path)).toEqual(['/usr/bin/nvidia-smi']);
  });

  it('checks real files with the default fileExists', async () => {
    // Real paths of the host OS (a Windows temp dir contains ':' so it cannot go in a Linux PATH).
    const platform = process.platform === 'win32' ? 'win32' : 'linux';
    const name = platform === 'win32' ? 'nvidia-smi.exe' : 'nvidia-smi';
    const dir = mkdtempSync(path.join(os.tmpdir(), 'gb-smi-'));
    const file = path.join(dir, name);
    writeFileSync(file, '');
    expect(await defaultFileExists(file)).toBe(true);
    expect(await defaultFileExists(dir)).toBe(false);
    expect(await defaultFileExists(path.join(dir, 'missing'))).toBe(false);
    const loc = await locateNvidiaSmi({ platform, env: { PATH: dir } });
    expect(loc?.path).toBe(file);
  });

  it('reads env vars case-insensitively only on Windows', () => {
    expect(envGet({ Path: 'a' }, 'PATH', 'win32')).toBe('a');
    expect(envGet({ Path: 'a' }, 'PATH', 'linux')).toBeUndefined();
    expect(envGet({}, 'PATH', 'win32')).toBeUndefined();
  });
});

describe('parseDriverInfo', () => {
  it('reads KMD / CUDA UMD versions from the 617 --version and header (Windows, WSL)', () => {
    for (const f of ['win-version.txt', 'win-plain.txt', 'wsl-version.txt', 'wsl-plain.txt']) {
      expect(parseDriverInfo(fixture(`nvidia-smi/${f}`, { crlf: f.startsWith('win') })), f).toEqual({ driverVersion: '617.14', cudaVersion: '13.4' });
    }
  });

  it('reads the classic Driver/CUDA Version names of older drivers', () => {
    expect(parseDriverInfo(fixture('nvidia-smi/handmade/r535-version.txt'))).toEqual({ driverVersion: '535.183.01', cudaVersion: '12.2' });
    expect(parseDriverInfo(fixture('nvidia-smi/handmade/r535-plain-header.txt'))).toEqual({ driverVersion: '535.183.01', cudaVersion: '12.2' });
    expect(parseDriverInfo(fixture('nvidia-smi/handmade/legacy-plain.txt'))).toEqual({ driverVersion: '470.223.02', cudaVersion: '11.4' });
  });

  it('leaves out what is missing ("CUDA Version: N/A", unsupported --version)', () => {
    expect(parseDriverInfo(fixture('nvidia-smi/handmade/no-cuda-header.txt'))).toEqual({ driverVersion: '560.35.03' });
    expect(parseDriverInfo(fixture('nvidia-smi/handmade/legacy-version-unsupported.txt'))).toEqual({});
  });
});

describe('classifyFailure', () => {
  const code = (out: Parameters<typeof classifyFailure>[0]) => classifyFailure(out).code;

  it('maps the real and known failure outputs to error codes', () => {
    expect(code(ok(fixture('nvidia-smi/win-no-devices.txt'), 6))).toBe('GPU_NOT_FOUND');
    expect(code(ok(fixture('nvidia-smi/handmade/driver-missing.txt'), 9))).toBe('DRIVER_MISSING');
    expect(code({ code: 18, stdout: '', stderr: fixture('nvidia-smi/handmade/nvml-mismatch.txt'), timedOut: false })).toBe('DRIVER_MISSING');
    expect(code({ code: null, stdout: '', stderr: 'Error: spawn nvidia-smi ENOENT', timedOut: false })).toBe('DRIVER_MISSING');
    expect(code({ code: null, stdout: '', stderr: '', timedOut: true })).toBe('INTERNAL');
  });

  it('keeps a bounded tail of the output as detail', () => {
    const e = classifyFailure(ok('x'.repeat(2000), 3));
    expect(e).toBeInstanceOf(AppError);
    expect(e.message).toContain('exit code 3');
    expect(e.detail).toHaveLength(800);
    expect(classifyFailure(ok('', 4)).detail).toBeUndefined();
  });
});

describe('NvidiaSmiCli', () => {
  const loc: NvidiaSmiLocation = { argv: ['node', 'fake.mjs'], path: 'node fake.mjs', source: 'override' };
  const specs: FieldSpec[] = [
    { key: 'index', names: ['index'], required: true },
    { key: 'power', names: ['power.draw.instant', 'power.draw'], minimal: true },
    { key: 'cc', names: ['compute_cap'] },
  ];
  const fieldsOf = (args: string[]) => args.find((a) => a.startsWith('--query-gpu='))!.slice('--query-gpu='.length);
  const rejectField = (f: string) => ok(`Field "${f}" is not a valid field to query.\n\n`, 2);

  it('prefixes the argv and passes a timeout', async () => {
    const r = new FakeRunner(() => ok('out'));
    const cli = new NvidiaSmiCli(r, loc, 1234);
    expect(cli.command(['-L'])).toEqual({ cmd: 'node', args: ['fake.mjs', '-L'] });
    expect(await cli.text(['-L'])).toBe('out');
    expect(r.calls[0]).toEqual({ cmd: 'node', args: ['fake.mjs', '-L'], opts: { timeoutMs: 1234 } });
  });

  it('throws a classified error on failure or timeout', async () => {
    const cli = new NvidiaSmiCli(new FakeRunner(() => ok(fixture('nvidia-smi/handmade/driver-missing.txt'), 9)), loc);
    await expect(cli.text([])).rejects.toMatchObject({ code: 'DRIVER_MISSING' });
    const slow = new NvidiaSmiCli(new FakeRunner(() => ok('', 0, { timedOut: true })), loc);
    await expect(slow.text([])).rejects.toMatchObject({ code: 'INTERNAL' });
  });

  it('switches to aliases, then drops fields, as an old driver rejects them', async () => {
    const r = new FakeRunner((_c, args) => {
      const f = fieldsOf(args);
      if (f.includes('power.draw.instant')) return rejectField('power.draw.instant');
      // WSL style: the error comes with exit code 0.
      if (f.includes('compute_cap')) return ok('Field "compute_cap" is not a valid field to query.\n\n', 0);
      return ok('0, 12.5\n');
    });
    const res = await new NvidiaSmiCli(r, loc).queryFields('--query-gpu', specs);
    expect(res.choice).toEqual({ index: 'index', power: 'power.draw', cc: null });
    expect(res.fields.map((f) => f.name)).toEqual(['index', 'power.draw']);
    expect(res.stdout).toBe('0, 12.5\n');
    expect(r.calls.map((c) => fieldsOf(c.args))).toEqual(['index,power.draw.instant,compute_cap', 'index,power.draw,compute_cap', 'index,power.draw']);
    expect(r.calls[0]!.args.slice(-1)).toEqual(['--format=csv,noheader,nounits']);
  });

  it('starts from a cached choice and appends extra args', async () => {
    const r = new FakeRunner(() => ok('0, 1'));
    const choice = { ...initialChoice(specs), cc: null };
    await new NvidiaSmiCli(r, loc).queryFields('--query-compute-apps', specs, choice, ['-i', '0']);
    expect(r.calls[0]!.args).toEqual(['fake.mjs', '--query-compute-apps=index,power.draw.instant', '--format=csv,noheader,nounits', '-i', '0']);
  });

  it('falls back to the minimal list when the rejected field cannot be identified, then gives up', async () => {
    let n = 0;
    const r = new FakeRunner((_c, args) => {
      n++;
      if (fieldsOf(args).includes('compute_cap')) return ok('That is not a valid field to query.', 2);
      return ok('0, 1');
    });
    const res = await new NvidiaSmiCli(r, loc).queryFields('--query-gpu', specs);
    expect(res.choice).toEqual({ index: 'index', power: 'power.draw.instant', cc: null });
    expect(n).toBe(2);

    const always = new FakeRunner(() => ok('Field "index" is not a valid field to query.', 2));
    await expect(new NvidiaSmiCli(always, loc).queryFields('--query-gpu', specs)).rejects.toMatchObject({
      code: 'DRIVER_TOO_OLD',
      params: { field: 'index' },
    });
    expect(always.calls).toHaveLength(2);
  });

  it('throws classified errors that are not about fields', async () => {
    const r = new FakeRunner(() => ok(fixture('nvidia-smi/win-no-devices.txt'), 6));
    await expect(new NvidiaSmiCli(r, loc).queryFields('--query-gpu', specs)).rejects.toMatchObject({ code: 'GPU_NOT_FOUND' });
  });
});
