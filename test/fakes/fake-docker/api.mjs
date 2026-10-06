// Fake Docker Engine API on a Windows named pipe or a unix socket (the transport the real
// daemon uses), for the DockerApi client tests. Also runnable: `node fake-docker.mjs __api`.
import { randomBytes, createHash } from 'node:crypto';
import { rmSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function randomSocketPath() {
  const id = randomBytes(6).toString('hex');
  return process.platform === 'win32' ? `\\\\.\\pipe\\gpubench-fake-docker-${id}` : path.join(os.tmpdir(), `gpubench-fake-docker-${id}.sock`);
}

function digestOf(ref) {
  return `sha256:${createHash('sha256').update(`digest:${ref}`).digest('hex')}`;
}

function repoOf(ref) {
  const at = ref.indexOf('@');
  const r = at >= 0 ? ref.slice(0, at) : ref;
  const c = r.lastIndexOf(':');
  return c > r.lastIndexOf('/') ? r.slice(0, c) : r;
}

/**
 * @param {import('./api.d.mts').FakeDockerApiOptions} [opts]
 * @returns {Promise<import('./api.d.mts').FakeDockerApi>}
 */
export async function startFakeDockerApi(opts = {}) {
  const socketPath = opts.socketPath ?? randomSocketPath();
  const state = {
    mode: opts.mode ?? 'ok',
    images: new Map(Object.entries(opts.images ?? {})),
    containers: [...(opts.containers ?? [])],
    volumes: new Map(Object.entries(opts.volumes ?? {})),
    pull: opts.pull ?? {},
    info: opts.info ?? {},
  };
  const requests = [];

  const json = (res, status, body) => {
    const text = JSON.stringify(body);
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text), 'api-version': '1.51', ostype: 'linux' });
    res.end(text);
  };
  const readBody = (req) =>
    new Promise((resolve) => {
      let s = '';
      req.setEncoding('utf8');
      req.on('data', (d) => (s += d));
      req.on('end', () => {
        try {
          resolve(s ? JSON.parse(s) : {});
        } catch {
          resolve({});
        }
      });
    });

  async function pull(req, res, url) {
    const repo = url.searchParams.get('fromImage') ?? '';
    const tag = url.searchParams.get('tag') ?? 'latest';
    const ref = tag.startsWith('sha256:') ? `${repo}@${tag}` : `${repo}:${tag}`;
    const p = state.pull;
    if (p.error === 'not-found') return json(res, 404, { message: `manifest for ${ref} not found: manifest unknown: manifest unknown` });
    if (p.error === 'denied') {
      return json(res, 404, { message: `pull access denied for ${repo}, repository does not exist or may require 'docker login': denied: requested access to the resource is denied` });
    }
    if (p.error === 'http-500') return json(res, 500, { message: 'Get "https://registry-1.docker.io/v2/": net/http: request canceled (Client.Timeout exceeded)' });
    res.writeHead(200, { 'content-type': 'application/json' });
    const send = (m) => res.write(`${JSON.stringify(m)}\n`);
    const layers = p.layers ?? [
      { id: 'a1b2c3d4e5f6', size: 3_000_000 },
      { id: 'b2c3d4e5f6a1', size: 5_000_000 },
      { id: 'c3d4e5f6a1b2', size: 0, exists: true },
    ];
    const steps = p.steps ?? 4;
    send({ status: `Pulling from ${repo}`, id: tag });
    for (const l of layers) send(l.exists ? { status: 'Already exists', progressDetail: {}, id: l.id } : { status: 'Pulling fs layer', progressDetail: {}, id: l.id });
    for (const l of layers.filter((x) => !x.exists)) send({ status: 'Waiting', progressDetail: {}, id: l.id });
    for (const l of layers.filter((x) => !x.exists)) {
      for (let i = 1; i <= steps; i++) {
        if (p.stallAt !== undefined && i === p.stallAt) {
          // Never answers again: cancellation tests.
          await new Promise(() => {});
        }
        const current = Math.round((l.size * i) / steps);
        send({ status: 'Downloading', progressDetail: { current, total: l.size }, progress: `[====>] ${current}/${l.size}`, id: l.id });
        if (p.delayMs) await sleep(p.delayMs);
      }
      send({ status: 'Verifying Checksum', progressDetail: {}, id: l.id });
      send({ status: 'Download complete', progressDetail: {}, id: l.id });
      if (p.error === 'stream-error' || p.error === 'no-space') {
        const message =
          p.error === 'no-space'
            ? `write /var/lib/docker/tmp/GetImageBlob123: no space left on device`
            : `unauthorized: authentication required`;
        send({ errorDetail: { message }, error: message });
        res.end();
        return;
      }
    }
    for (const l of layers.filter((x) => !x.exists)) {
      send({ status: 'Extracting', progressDetail: { current: l.size, total: l.size }, id: l.id });
      send({ status: 'Pull complete', progressDetail: {}, id: l.id });
    }
    send({ status: `Digest: ${digestOf(ref)}` });
    send({ status: `Status: Downloaded newer image for ${ref}` });
    state.images.set(ref, { Id: `sha256:${createHash('sha256').update(`id:${ref}`).digest('hex')}`, RepoTags: [ref], RepoDigests: [`${repoOf(ref)}@${digestOf(ref)}`], Size: 123_456_789 });
    res.end();
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://docker');
    const pathname = url.pathname.replace(/^\/v\d+\.\d+/, '');
    requests.push({ method: req.method ?? 'GET', path: pathname, query: url.search });
    if (state.mode === 'starting') return json(res, 500, { message: 'Docker Desktop is starting' });
    if (state.mode === 'hang') return;
    if (pathname === '/_ping') {
      res.writeHead(200, { 'content-type': 'text/plain', 'api-version': '1.51', ostype: 'linux' });
      return res.end('OK');
    }
    if (pathname === '/version') {
      const podman = state.mode === 'podman';
      return json(res, 200, {
        Platform: { Name: podman ? '' : 'Docker Desktop 4.47.0 (210443)' },
        Components: podman ? [{ Name: 'Podman Engine', Version: '5.2.0' }] : [{ Name: 'Engine', Version: '29.8.0' }, { Name: 'containerd', Version: '1.7.27' }],
        Version: podman ? '5.2.0' : '29.8.0',
        ApiVersion: '1.51',
        Os: 'linux',
        Arch: 'amd64',
      });
    }
    if (pathname === '/info') {
      return json(res, 200, {
        ServerVersion: '29.8.0',
        OSType: 'linux',
        OperatingSystem: 'Docker Desktop',
        NCPU: 32,
        MemTotal: 67_000_000_000,
        Runtimes: { runc: { path: 'runc' }, 'io.containerd.runc.v2': { path: 'runc' } },
        ...state.info,
      });
    }
    if (pathname === '/images/create' && req.method === 'POST') return pull(req, res, url);
    const img = /^\/images\/(.+)\/json$/.exec(pathname);
    if (img && req.method === 'GET') {
      const ref = decodeURIComponent(img[1]);
      const found = state.images.get(ref);
      return found ? json(res, 200, found) : json(res, 404, { message: `No such image: ${ref}` });
    }
    if (pathname === '/containers/json') {
      let rows = state.containers;
      const f = url.searchParams.get('filters');
      if (f) {
        const labels = JSON.parse(f).label ?? [];
        rows = rows.filter((c) =>
          labels.every((l) => {
            const [k, v] = l.split('=');
            return v === undefined ? k in (c.Labels ?? {}) : (c.Labels ?? {})[k] === v;
          }),
        );
      }
      return json(res, 200, rows);
    }
    const cont = /^\/containers\/([^/]+)(\/json)?$/.exec(pathname);
    if (cont) {
      const id = decodeURIComponent(cont[1]);
      const c = state.containers.find((x) => x.Id === id || (x.Names ?? []).includes(`/${id}`));
      if (cont[2] && req.method === 'GET') {
        if (!c) return json(res, 404, { message: `No such container: ${id}` });
        return json(res, 200, {
          Id: c.Id,
          Name: (c.Names ?? [''])[0],
          State: { Status: c.State, Running: c.State === 'running', ExitCode: c.ExitCode ?? 0, OOMKilled: c.OOMKilled ?? false, StartedAt: c.StartedAt ?? '2026-10-06T10:00:00.123456789Z' },
          Config: { Labels: c.Labels ?? {} },
        });
      }
      if (!cont[2] && req.method === 'DELETE') {
        if (!c) return json(res, 404, { message: `No such container: ${id}` });
        if (c.State === 'running' && url.searchParams.get('force') !== 'true') return json(res, 409, { message: 'container is running' });
        state.containers = state.containers.filter((x) => x !== c);
        res.writeHead(204);
        return res.end();
      }
    }
    if (pathname === '/volumes/create' && req.method === 'POST') {
      const body = await readBody(req);
      const v = { Name: body.Name, Driver: 'local', Mountpoint: `/var/lib/docker/volumes/${body.Name}/_data`, Labels: body.Labels ?? {}, Scope: 'local' };
      state.volumes.set(body.Name, v);
      return json(res, 201, v);
    }
    const vol = /^\/volumes\/([^/]+)$/.exec(pathname);
    if (vol && req.method === 'GET') {
      const v = state.volumes.get(decodeURIComponent(vol[1]));
      return v ? json(res, 200, v) : json(res, 404, { message: `get ${vol[1]}: no such volume` });
    }
    return json(res, 404, { message: 'page not found' });
  });

  const sockets = new Set();
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  if (process.platform !== 'win32') rmSync(socketPath, { force: true });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });

  return {
    socketPath,
    requests,
    state,
    set(patch) {
      Object.assign(state, patch);
    },
    close: () =>
      new Promise((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => {
          if (process.platform !== 'win32') rmSync(socketPath, { force: true });
          resolve();
        });
      }),
  };
}
