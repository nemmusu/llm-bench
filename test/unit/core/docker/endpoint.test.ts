import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  contextHost,
  contextMetaFile,
  currentContext,
  defaultEndpoints,
  dockerConfigDir,
  endpointKey,
  parseDockerHost,
  resolveDockerEndpoints,
} from '../../../../src/core/docker/endpoint';
import { DOCKER_FIXTURES } from './helpers';

const fixture = (name: string) => readFileSync(path.join(DOCKER_FIXTURES, name), 'utf8');

describe('parseDockerHost', () => {
  it('handles npipe, unix, tcp, http(s) and bare override paths', () => {
    expect(parseDockerHost('npipe:////./pipe/dockerDesktopLinuxEngine', 'env')).toEqual({
      kind: 'socket',
      path: '\\\\.\\pipe\\dockerDesktopLinuxEngine',
      source: 'env',
    });
    expect(parseDockerHost('unix:///var/run/docker.sock', 'context')).toEqual({ kind: 'socket', path: '/var/run/docker.sock', source: 'context' });
    expect(parseDockerHost('tcp://10.0.0.2:2375', 'env')).toEqual({ kind: 'tcp', host: '10.0.0.2', port: 2375, tls: false, source: 'env' });
    expect(parseDockerHost('tcp://docker.local', 'env', true)).toEqual({ kind: 'tcp', host: 'docker.local', port: 2376, tls: true, source: 'env' });
    expect(parseDockerHost('tcp://docker.local', 'env')).toMatchObject({ port: 2375, tls: false });
    expect(parseDockerHost('https://h:9443/', 'override')).toMatchObject({ kind: 'tcp', host: 'h', port: 9443, tls: true });
    expect(parseDockerHost('http://[::1]:2375', 'override')).toMatchObject({ host: '::1', port: 2375, tls: false });
    expect(parseDockerHost('//./pipe/fake', 'override')).toEqual({ kind: 'socket', path: '\\\\.\\pipe\\fake', source: 'override' });
    expect(parseDockerHost('\\\\.\\pipe\\fake', 'override')).toEqual({ kind: 'socket', path: '\\\\.\\pipe\\fake', source: 'override' });
    expect(parseDockerHost('/tmp/fake.sock', 'override')).toEqual({ kind: 'socket', path: '/tmp/fake.sock', source: 'override' });
  });

  it('ignores unsupported schemes and bare paths outside the override', () => {
    expect(parseDockerHost('ssh://user@host', 'env')).toBeUndefined();
    expect(parseDockerHost('/tmp/x.sock', 'env')).toBeUndefined();
    expect(parseDockerHost('garbage', 'override')).toBeUndefined();
  });
});

describe('context store', () => {
  it('hashes the context name like the docker CLI (real meta.json layout)', () => {
    const file = contextMetaFile('C:/Users/u/.docker', 'desktop-linux');
    expect(file.replace(/\\/g, '/')).toBe(
      'C:/Users/u/.docker/contexts/meta/fe9c6bd7a66301f49ca9b6a70b217107cd1284598bfc254700c989b916da791e/meta.json',
    );
  });

  it('reads currentContext from config.json, DOCKER_CONTEXT first', async () => {
    const read = async (p: string) => {
      if (p.endsWith('config.json')) return fixture('config.json');
      throw new Error('ENOENT');
    };
    expect(await currentContext({}, '/cfg', read)).toBe('desktop-linux');
    expect(await currentContext({ DOCKER_CONTEXT: 'other' }, '/cfg', read)).toBe('other');
    expect(await currentContext({}, '/cfg', async () => '{"currentContext":""}')).toBeUndefined();
    expect(await currentContext({}, '/cfg', async () => 'not json')).toBeUndefined();
  });

  it('reads the docker host of a context', async () => {
    expect(await contextHost('/cfg', 'desktop-linux', async () => fixture('context-desktop-linux.meta.json'))).toBe(
      'npipe:////./pipe/dockerDesktopLinuxEngine',
    );
    expect(await contextHost('/cfg', 'x', async () => '{"Endpoints":{}}')).toBeUndefined();
    expect(await contextHost('/cfg', 'x', async () => '{"Endpoints":{"docker":{"Host":""}}}')).toBeUndefined();
    expect(await contextHost('/cfg', 'x', () => Promise.reject(new Error('ENOENT')))).toBeUndefined();
  });

  it('honours DOCKER_CONFIG', () => {
    expect(dockerConfigDir({ DOCKER_CONFIG: '/x' }, '/home/u')).toBe('/x');
    expect(dockerConfigDir({}, '/home/u')).toBe(path.join('/home/u', '.docker'));
  });
});

describe('defaultEndpoints', () => {
  it('lists Docker Desktop pipes on Windows', () => {
    expect(defaultEndpoints('win32', {}, 'C:\\Users\\u').map((e) => endpointKey(e))).toEqual([
      'socket:\\\\.\\pipe\\dockerDesktopLinuxEngine',
      'socket:\\\\.\\pipe\\docker_engine',
    ]);
  });
  it('lists system, rootless and Desktop sockets on Linux and macOS', () => {
    expect(defaultEndpoints('linux', { XDG_RUNTIME_DIR: '/run/user/1000' }, '/home/u', 1000).map((e) => endpointKey(e))).toEqual([
      'socket:/var/run/docker.sock',
      'socket:/run/user/1000/docker.sock',
      'socket:/home/u/.docker/desktop/docker.sock',
      'socket:/run/user/1000/docker.sock',
    ]);
    expect(defaultEndpoints('darwin', {}, '/Users/u').map((e) => endpointKey(e))).toEqual([
      'socket:/var/run/docker.sock',
      'socket:/Users/u/.docker/desktop/docker.sock',
      'socket:/Users/u/.docker/run/docker.sock',
    ]);
  });
  it('keys tcp endpoints by host, port and TLS', () => {
    expect(endpointKey({ kind: 'tcp', host: 'h', port: 1, tls: true, source: 'env' })).toBe('tcp:h:1:true');
  });
});

describe('resolveDockerEndpoints', () => {
  const realGetuid = process.getuid;
  afterEach(() => {
    process.getuid = realGetuid;
  });

  it('orders override, DOCKER_HOST, context, defaults and removes duplicates', async () => {
    const read = async (p: string) => {
      if (p.endsWith('config.json')) return fixture('config.json');
      return fixture('context-desktop-linux.meta.json');
    };
    const eps = await resolveDockerEndpoints({
      platform: 'win32',
      env: { DOCKER_HOST: 'tcp://127.0.0.1:2375', DOCKER_TLS_VERIFY: '0' },
      home: 'C:\\Users\\u',
      override: '\\\\.\\pipe\\gpubench-fake',
      readFile: read,
    });
    expect(eps.map((e) => `${e.source}:${endpointKey(e)}`)).toEqual([
      'override:socket:\\\\.\\pipe\\gpubench-fake',
      'env:tcp:127.0.0.1:2375:false',
      'context:socket:\\\\.\\pipe\\dockerDesktopLinuxEngine',
      'default:socket:\\\\.\\pipe\\docker_engine',
    ]);
  });

  it('skips the "default" context and unreadable stores; TLS from DOCKER_TLS_VERIFY', async () => {
    const eps = await resolveDockerEndpoints({
      platform: 'linux',
      env: { DOCKER_CONTEXT: 'default', DOCKER_HOST: 'tcp://h:2376', DOCKER_TLS_VERIFY: '1' },
      home: '/home/u',
      readFile: () => Promise.reject(new Error('ENOENT')),
      uid: 1001,
    });
    expect(eps[0]).toMatchObject({ kind: 'tcp', tls: true });
    expect(eps.map((e) => endpointKey(e))).toContain('socket:/run/user/1001/docker.sock');
  });

  it('ignores a context whose store has no host', async () => {
    const eps = await resolveDockerEndpoints({
      platform: 'linux',
      env: { DOCKER_CONTEXT: 'broken' },
      home: '/home/u',
      readFile: async () => '{}',
      uid: 0,
    });
    expect(eps.every((e) => e.source === 'default')).toBe(true);
  });

  it('uses the process uid when none is injected, and the real file system by default', async () => {
    process.getuid = () => 4242;
    const eps = await resolveDockerEndpoints({ platform: 'linux', env: { DOCKER_CONFIG: path.join(DOCKER_FIXTURES, 'missing') }, home: '/home/u' });
    expect(eps.map((e) => endpointKey(e))).toContain('socket:/run/user/4242/docker.sock');
    (process as { getuid?: unknown }).getuid = undefined;
    const none = await resolveDockerEndpoints({ platform: 'linux', env: {}, home: '/nonexistent-home' });
    expect(none.some((e) => endpointKey(e).includes('/run/user/'))).toBe(false);
  });
});
