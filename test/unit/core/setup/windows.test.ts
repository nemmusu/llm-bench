import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DOCKER_MIN_WSL,
  decodeWslOutput,
  detectWsl,
  parseWslDefaultVersion,
  parseWslVersion,
  system32,
} from '../../../../src/core/setup/wsl';
import {
  DOCKER_SIGNER,
  LAUNCH_SCRIPT,
  VERIFY_SCRIPT,
  launchInteractive,
  parseAuthenticode,
  parseLaunch,
  powershellPath,
  subjectField,
  verifyAuthenticode,
} from '../../../../src/core/setup/windows';
import { FIXTURES, FakeRunner, fixture, ok } from '../telemetry/fakes';

/** What ProcessRunner hands back for UTF-16 output: the bytes decoded as UTF-8. */
const utf16AsRunnerSees = (rel: string) => readFileSync(path.join(FIXTURES, rel)).toString('utf8');

const STATUS_UTF16 = utf16AsRunnerSees('setup/wsl-status.utf16.stdout.bin');
const VERSION_UTF16 = utf16AsRunnerSees('setup/wsl-version.utf16.stdout.bin');
const STATUS_UTF8 = fixture('setup/wsl-status.utf8.stdout.txt');
const VERSION_UTF8 = fixture('setup/wsl-version.utf8.stdout.txt');
const SIG_VALID = fixture('setup/authenticode-docker-valid.stdout.txt');
const SIG_UNSIGNED = fixture('setup/authenticode-unsigned.stdout.txt');
const ENV = { SystemRoot: 'C:\\Windows' };

describe('wsl output parsing (real captures, Italian Windows 11)', () => {
  it('decodes UTF-16 output read as UTF-8', () => {
    expect(STATUS_UTF16).toContain('\u0000');
    expect(decodeWslOutput(STATUS_UTF16)).toContain('Versione predefinita: 2');
    expect(decodeWslOutput('\uFEFFabc')).toBe('abc');
  });

  it('reads the default version in both encodings', () => {
    expect(parseWslDefaultVersion(STATUS_UTF16)).toBe(2);
    expect(parseWslDefaultVersion(STATUS_UTF8)).toBe(2);
    expect(parseWslDefaultVersion('Default Version: 1\r\n')).toBe(1);
    expect(parseWslDefaultVersion('nothing useful')).toBeUndefined();
  });

  it('reads the WSL version in both encodings', () => {
    expect(parseWslVersion(VERSION_UTF16)).toBe('2.7.14.0');
    expect(parseWslVersion(VERSION_UTF8)).toBe('2.7.14.0');
    expect(parseWslVersion('\n\nWSL version: 2.1.5.0\n')).toBe('2.1.5.0');
    expect(parseWslVersion('Usage: wsl.exe [Argument]')).toBeUndefined();
    expect(parseWslVersion('')).toBeUndefined();
  });

  it('resolves System32 tools from SystemRoot, never from PATH', () => {
    expect(system32({ SystemRoot: 'D:\\Win' }, 'wsl.exe')).toBe('D:\\Win\\System32\\wsl.exe');
    expect(system32({ SYSTEMROOT: 'E:\\W' }, 'a.exe')).toBe('E:\\W\\System32\\a.exe');
    expect(system32({ windir: 'F:\\W' }, 'a.exe')).toBe('F:\\W\\System32\\a.exe');
    expect(system32({}, 'a.exe')).toBe('C:\\Windows\\System32\\a.exe');
    expect(powershellPath(ENV)).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  });
});

describe('detectWsl', () => {
  it('reports WSL 2 with its version (UTF-16 output, WSL_UTF8 ignored)', async () => {
    const proc = new FakeRunner((_c, args) => ok(args[0] === '--status' ? STATUS_UTF16 : VERSION_UTF16));
    expect(await detectWsl(proc, ENV)).toEqual({ available: true, defaultVersion: 2, version: '2.7.14.0', meetsDockerMinimum: true });
    expect(proc.calls[0]).toMatchObject({ cmd: 'C:\\Windows\\System32\\wsl.exe', args: ['--status'], opts: { env: { WSL_UTF8: '1' } } });
  });

  it('flags a WSL older than Docker Desktop needs', async () => {
    const proc = new FakeRunner((_c, args) => ok(args[0] === '--status' ? 'x' : 'WSL version: 2.0.9.0'));
    expect(await detectWsl(proc, ENV)).toEqual({ available: true, version: '2.0.9.0', meetsDockerMinimum: false });
    expect(DOCKER_MIN_WSL).toBe('2.1.5');
  });

  it('copes with inbox WSL without --version', async () => {
    const proc = new FakeRunner((_c, args) => (args[0] === '--status' ? ok(STATUS_UTF8) : ok('help', 1)));
    expect(await detectWsl(proc, ENV)).toEqual({ available: true, defaultVersion: 2 });
    const rejecting = new FakeRunner((_c, args) => (args[0] === '--status' ? ok(STATUS_UTF8) : Promise.reject(new Error('x'))));
    expect(await detectWsl(rejecting, ENV)).toEqual({ available: true, defaultVersion: 2 });
  });

  it('reports WSL missing or not installed', async () => {
    expect(await detectWsl(new FakeRunner(() => ok('', null, { stderr: 'spawn ENOENT' })), ENV)).toEqual({ available: false, reason: 'wsl-missing' });
    expect(await detectWsl(new FakeRunner(() => Promise.reject(new Error('x'))), ENV)).toEqual({ available: false, reason: 'wsl-missing' });
    expect(await detectWsl(new FakeRunner(() => ok('not installed', 1)), ENV)).toEqual({ available: false, reason: 'not-installed' });
    expect(await detectWsl(new FakeRunner(() => ok('', null, { timedOut: true })), ENV)).toEqual({ available: false, reason: 'not-installed' });
  });
});

describe('Authenticode', () => {
  it('parses the real outputs of the verify script', () => {
    expect(parseAuthenticode(SIG_VALID)).toEqual({
      status: 'Valid',
      subject: expect.stringContaining('O=Docker Inc') as unknown as string,
      thumbprint: 'B6BD29272B07AD4D0F1322A739499D67CA3BAC3F',
    });
    expect(parseAuthenticode(SIG_UNSIGNED)).toEqual({ status: 'NotSigned' });
  });

  it('accepts numeric enum values and rejects junk', () => {
    expect(parseAuthenticode('{"Status":0,"Subject":"CN=x"}')).toEqual({ status: 'Valid', subject: 'CN=x' });
    expect(parseAuthenticode('{"Status":42}')).toEqual({ status: '42' });
    expect(parseAuthenticode('warning\n')).toBeUndefined();
    expect(parseAuthenticode('{not json')).toBeUndefined();
    expect(parseAuthenticode('{"Nope":1}')).toBeUndefined();
  });

  it('reads subject fields', () => {
    const s = 'CN=Docker Inc, O=Docker Inc, L=Palo Alto, OID.2.5.4.15=Private Organization';
    expect(subjectField(s, 'cn')).toBe('Docker Inc');
    expect(subjectField(s, 'O')).toBe('Docker Inc');
    expect(subjectField('CN=x, O="Docker, Inc."', 'O')).toBe('Docker, Inc.');
    expect(subjectField(s, 'OU')).toBeUndefined();
    expect(DOCKER_SIGNER.test('Docker, Inc.')).toBe(true);
    expect(DOCKER_SIGNER.test('Not Docker Inc')).toBe(false);
  });

  it('passes the path through the environment, never inside the script', async () => {
    const file = "C:\\tmp\\evil'; Remove-Item C:\\ -Recurse; '.exe";
    const proc = new FakeRunner(() => ok(SIG_VALID));
    const info = await verifyAuthenticode(proc, ENV, file);
    expect(info.status).toBe('Valid');
    const call = proc.calls[0];
    expect(call?.cmd).toBe(powershellPath(ENV));
    expect(call?.args).toEqual(['-NoProfile', '-NonInteractive', '-Command', VERIFY_SCRIPT]);
    expect(call?.args.join(' ')).not.toContain('evil');
    expect(call?.opts?.env).toEqual({ GPUBENCH_VERIFY_FILE: file });
  });

  it('accepts a CN-only Docker signer', async () => {
    const proc = new FakeRunner(() => ok('{"Status":"Valid","Subject":"CN=Docker Inc, O=Other"}'));
    await expect(verifyAuthenticode(proc, ENV, 'f.exe')).resolves.toMatchObject({ status: 'Valid' });
  });

  it('refuses unsigned, tampered, foreign-signed or unreadable files', async () => {
    const check = (stdout: string, code = 0) => verifyAuthenticode(new FakeRunner(() => ok(stdout, code, { stderr: code ? 'boom' : '' })), ENV, 'f.exe');
    await expect(check(SIG_UNSIGNED)).rejects.toMatchObject({ code: 'ENGINE_INSTALL_FAILED', params: { reason: 'bad-signature', check: 'status', status: 'NotSigned' } });
    await expect(check('{"Status":"HashMismatch"}')).rejects.toMatchObject({ params: { check: 'status' } });
    await expect(check('{"Status":"Valid","Subject":"CN=Evil Corp, O=Evil Corp"}')).rejects.toMatchObject({ params: { check: 'signer' } });
    await expect(check('{"Status":"Valid"}')).rejects.toMatchObject({ params: { check: 'signer', subject: '' } });
    await expect(check('', 1)).rejects.toMatchObject({ params: { check: 'no-result', detail: 'boom' } });
    await expect(check('nothing')).rejects.toMatchObject({ params: { check: 'no-result', detail: 'nothing' } });
  });
});

describe('interactive launch', () => {
  it('parses exit codes and ShellExecute failures', () => {
    expect(parseLaunch('{"exitCode":0}')).toEqual({ exitCode: 0 });
    expect(parseLaunch('noise\r\n{"error":"start-failed","nativeErrorCode":1223,"message":"annullata"}\r\n')).toEqual({ nativeErrorCode: 1223, message: 'annullata' });
    expect(parseLaunch('{"exitCode":null,"nativeErrorCode":null,"message":""}')).toEqual({});
    expect(parseLaunch('')).toBeUndefined();
    expect(parseLaunch('{bad')).toBeUndefined();
    expect(parseLaunch('{"exitCode":"x"}')).toBeUndefined();
  });

  it('starts the installer without arguments (nothing accepted on the user behalf)', async () => {
    const proc = new FakeRunner(() => ok('{"exitCode":3010}'));
    const ac = new AbortController();
    expect(await launchInteractive(proc, ENV, 'C:\\x\\Docker Desktop Installer.exe', ac.signal)).toEqual({ exitCode: 3010 });
    const call = proc.calls[0];
    expect(call?.args).toEqual(['-NoProfile', '-NonInteractive', '-Command', LAUNCH_SCRIPT]);
    expect(call?.opts).toEqual({ env: { GPUBENCH_INSTALLER: 'C:\\x\\Docker Desktop Installer.exe' }, signal: ac.signal });
    expect(LAUNCH_SCRIPT).not.toMatch(/accept-license|--quiet|ArgumentList/i);
    expect(call?.opts?.timeoutMs).toBeUndefined();
  });

  it('fails clearly when PowerShell prints nothing usable', async () => {
    await expect(launchInteractive(new FakeRunner(() => ok('', 1, { stderr: 'ps broke' })), ENV, 'f.exe')).rejects.toMatchObject({
      code: 'ENGINE_INSTALL_FAILED',
      params: { reason: 'launch-failed' },
      detail: 'ps broke',
    });
    await expect(launchInteractive(new FakeRunner(() => ok('junk')), ENV, 'f.exe')).rejects.toMatchObject({ detail: 'junk' });
  });
});
