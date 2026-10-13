import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { classifyDockerError, DockerCli, isEngineHang, parseDesktopStatus } from '../../../../src/core/docker/cli';
import { codeForState } from '../../../../src/core/docker/environment';
import { DOCKER_FIXTURES, fail, ok, scriptedProc } from './helpers';

describe('Docker Desktop status', () => {
  it('reads the status from its JSON at any depth, or from its table form', () => {
    expect(parseDesktopStatus('{"Status":"Running","SessionID":"x"}')).toBe('running');
    expect(parseDesktopStatus('{"Engines":[{"Name":"linux","State":"stopping"}]}')).toBe('stopping');
    expect(parseDesktopStatus('[{"name":"x"},{"status":"starting"}]')).toBe('starting');
    expect(parseDesktopStatus('{"engine":{"detail":{"status":"paused"}}}')).toBe('paused');
    expect(parseDesktopStatus('{"Status":"","Other":1}')).toBeUndefined();
    expect(parseDesktopStatus('[]')).toBeUndefined();
    expect(parseDesktopStatus('null')).toBeUndefined();
    expect(parseDesktopStatus('Name                Value\nStatus              running\nSessionID           x')).toBe('running');
    expect(parseDesktopStatus('nothing here')).toBeUndefined();
  });

  it('`docker desktop status --format json`: status, no answer, no plugin, Docker Desktop not running', async () => {
    const answers = [ok('{"Status":"stopping"}'), { code: null, stdout: '', stderr: '', timedOut: true }, fail(1, "docker: 'desktop' is not a docker command."), fail(1, readFileSync(path.join(DOCKER_FIXTURES, 'win-desktop-status-stopped.txt'), 'utf8'))];
    const proc = scriptedProc(() => answers.shift()!);
    const cli = new DockerCli({ proc, platform: 'win32', env: {}, override: ['docker'] });
    expect(await cli.desktopStatus(5000)).toEqual({ status: 'stopping', timedOut: false, missing: false });
    expect(proc.calls[0]).toMatchObject({ args: ['desktop', 'status', '--format', 'json'], opts: { timeoutMs: 5000 } });
    expect(await cli.desktopStatus(5000)).toEqual({ timedOut: true, missing: false });
    expect(await cli.desktopStatus(5000)).toEqual({ timedOut: false, missing: true });
    expect(await cli.desktopStatus(5000)).toEqual({ timedOut: false, missing: false });
  });
});

describe('a hung engine', () => {
  it('no answer in time, or the proxy giving up, is a hang; other failures are not', () => {
    expect(isEngineHang({ timedOut: true, stdout: '', stderr: '' })).toBe(true);
    expect(isEngineHang({ timedOut: false, stdout: '', stderr: 'Error response from daemon: context deadline exceeded' })).toBe(true);
    expect(isEngineHang({ timedOut: false, stdout: 'context deadline exceeded', stderr: '' })).toBe(true);
    expect(isEngineHang({ timedOut: false, stdout: '', stderr: 'No such container: x' })).toBe(false);
  });

  it('the proxy deadline (even inside a 500 answer) is DOCKER_NOT_RESPONDING, not "starting"', () => {
    const e = classifyDockerError(
      fail(1, 'request returned 500 Internal Server Error for API route and version http://%2F%2F.%2Fpipe%2FdockerDesktopLinuxEngine/v1.51/containers/create, check if the server supports the requested API version: context deadline exceeded'),
      'ENGINE_START_FAILED',
    );
    expect(e).toMatchObject({ code: 'DOCKER_NOT_RESPONDING', params: { reason: 'deadline' } });
  });

  it('"not-responding" maps to its own error code', () => {
    expect(codeForState('not-responding')).toBe('DOCKER_NOT_RESPONDING');
  });
});
