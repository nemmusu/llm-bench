// Fake GitHub for llama.cpp releases: the API listing (from the captured fixture, asset URLs
// rewritten to this server, sizes/digests matching the generated archives), ETag/304,
// rate limiting, and small archives generated on the fly with the real llama.cpp layouts.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import { makeTarGz, makeZip } from './archives.mjs';

const FIXTURE = new URL('../../fixtures/github/llamacpp-releases.json', import.meta.url);

/**
 * @typedef {object} FakeGithubOptions
 * @property {any[]} [releases]          GitHub-shaped releases (default: the captured fixture).
 * @property {boolean} [rateLimited]     Answer the API with 403 + x-ratelimit-remaining: 0.
 * @property {'flat' | 'nested'} [layout] Override the archive layout (default: real one per OS).
 * @property {'zip-slip' | 'absolute' | 'symlink-out'} [evil] Add a hostile entry to main archives.
 * @property {boolean} [wrongDigest]     Advertise digests that do not match the bytes.
 * @property {boolean} [noDigest]        Drop the `digest` field (older releases had none).
 * @property {number} [downloadStatus]   Force this HTTP status on downloads.
 * @property {boolean} [noServerBinary]  Generate main archives without llama-server.
 */

/**
 * Content of a generated asset, following what the real archives contain:
 * Windows zips are flat (llama-server.exe next to its DLLs); Linux tarballs wrap
 * everything in one `llama-<tag>/` folder and ship .so symlinks.
 * @param {string} name
 * @param {FakeGithubOptions} opts
 * @returns {Buffer}
 */
export function buildAsset(name, opts = {}) {
  const tagM = /^(?:cudart-)?llama-(b\d+)-/.exec(name);
  const tag = tagM ? tagM[1] : 'bX';
  const isZip = name.endsWith('.zip');
  const isTar = name.endsWith('.tar.gz');
  if (!isZip && !isTar) return Buffer.from(`fake asset ${name}\n`);
  const cudart = name.startsWith('cudart-');
  const cudaMajor = /cuda-(\d+)/.exec(name)?.[1];
  const backend = /-cuda-/.test(name) ? 'cuda' : /-vulkan-/.test(name) ? 'vulkan' : 'cpu';
  /** @type {import('./archives.mjs').ArchiveEntry[]} */
  let entries;
  if (isZip) {
    entries = cudart
      ? [
          { name: `cudart64_${cudaMajor}.dll`, data: `fake cudart ${cudaMajor}` },
          { name: `cublas64_${cudaMajor}.dll`, data: `fake cublas ${cudaMajor}` },
          { name: 'LICENSE', data: 'cudart license' },
        ]
      : [
          ...(opts.noServerBinary ? [] : [{ name: 'llama-server.exe', data: `fake llama-server ${tag} ${backend}` }]),
          { name: 'llama-bench.exe', data: 'fake llama-bench' },
          { name: 'llama.dll', data: 'fake llama.dll' },
          { name: 'ggml-base.dll', data: 'fake ggml-base' },
          { name: `ggml-${backend}.dll`, data: `fake ggml-${backend}` },
          { name: 'LICENSE', data: 'llama.cpp license' },
        ];
  } else {
    const top = cudart ? `cudart-llama-${tag}` : `llama-${tag}`;
    entries = cudart
      ? [
          { name: `${top}/`, type: 'dir' },
          { name: `${top}/libcudart.so.${cudaMajor}`, data: `fake libcudart ${cudaMajor}` },
          { name: `${top}/libcublas.so.${cudaMajor}`, data: `fake libcublas ${cudaMajor}` },
        ]
      : [
          { name: `${top}/`, type: 'dir' },
          ...(opts.noServerBinary ? [] : [{ name: `${top}/llama-server`, data: `fake llama-server ${tag} ${backend}`, mode: 0o755 }]),
          { name: `${top}/llama-bench`, data: 'fake llama-bench', mode: 0o644 },
          { name: `${top}/libllama.so`, data: 'fake libllama' },
          { name: `${top}/libggml-${backend}.so`, data: `fake libggml-${backend}` },
          { name: `${top}/libllama.so.0`, type: 'symlink', target: 'libllama.so' },
          { name: `${top}/LICENSE`, data: 'llama.cpp license' },
        ];
  }
  if (opts.layout === 'nested' && isZip) entries = entries.map((e) => ({ ...e, name: `llama-${tag}/${e.name}` }));
  if (opts.layout === 'flat' && isTar) {
    entries = entries.filter((e) => e.type !== 'dir').map((e) => ({ ...e, name: e.name.slice(e.name.indexOf('/') + 1) }));
  }
  if (!cudart && opts.evil === 'zip-slip') entries.push({ name: '../evil.txt', data: 'pwned' });
  if (!cudart && opts.evil === 'absolute') entries.push({ name: '/tmp/gpubench-evil.txt', data: 'pwned' });
  if (!cudart && opts.evil === 'symlink-out') entries.push({ name: 'escape', type: 'symlink', target: '../../outside' });
  return isZip ? makeZip(entries) : makeTarGz(entries);
}

/**
 * @param {FakeGithubOptions} [initial]
 */
export async function startFakeGithub(initial = {}) {
  const opts = { ...initial };
  const releases = opts.releases ?? JSON.parse(readFileSync(FIXTURE, 'utf8'));
  /** @type {Map<string, Buffer>} */
  const assets = new Map();
  /** @type {{ method: string, url: string, headers: http.IncomingHttpHeaders }[]} */
  const requests = [];

  const asset = (name) => {
    const key = `${name}|${opts.layout}|${opts.evil}|${opts.noServerBinary}`;
    let buf = assets.get(key);
    if (!buf) {
      buf = buildAsset(name, opts);
      assets.set(key, buf);
    }
    return buf;
  };

  const server = http.createServer((req, res) => {
    requests.push({ method: req.method ?? 'GET', url: req.url ?? '/', headers: req.headers });
    const url = new URL(req.url ?? '/', base);
    if (url.pathname === '/repos/ggml-org/llama.cpp/releases') {
      if (opts.rateLimited) {
        res.writeHead(403, {
          'content-type': 'application/json',
          'x-ratelimit-limit': '60',
          'x-ratelimit-remaining': '0',
          'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 3600),
        });
        res.end(JSON.stringify({ message: 'API rate limit exceeded for 127.0.0.1.' }));
        return;
      }
      const perPage = Number(url.searchParams.get('per_page') ?? 30);
      const list = releases.slice(0, perPage).map((r) => ({
        ...r,
        assets: r.assets.map((a) => {
          const buf = asset(a.name);
          const digest = `sha256:${createHash('sha256').update(opts.wrongDigest ? 'nope' : buf).digest('hex')}`;
          const out = { ...a, size: buf.length, browser_download_url: `${base}/download/${r.tag_name}/${a.name}` };
          if (opts.noDigest) delete out.digest;
          else out.digest = digest;
          return out;
        }),
      }));
      const body = JSON.stringify(list);
      const etag = `W/"${createHash('sha1').update(body).digest('hex')}"`;
      if (req.headers['if-none-match'] === etag) {
        res.writeHead(304, { etag, 'x-ratelimit-remaining': '59' });
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json', etag, 'x-ratelimit-remaining': '59' });
      res.end(body);
      return;
    }
    const dl = /^\/download\/([^/]+)\/([^/]+)$/.exec(url.pathname);
    if (dl) {
      if (opts.downloadStatus) {
        res.writeHead(opts.downloadStatus);
        res.end('error');
        return;
      }
      const buf = asset(decodeURIComponent(dl[2]));
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(buf.length) });
      res.end(buf);
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ message: 'Not Found' }));
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = /** @type {import('node:net').AddressInfo} */ (server.address()).port;
  const base = `http://127.0.0.1:${port}`;
  return {
    url: base,
    port,
    requests,
    /** @param {Partial<FakeGithubOptions>} patch */
    set(patch) {
      Object.assign(opts, patch);
    },
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve(undefined));
        server.closeAllConnections();
      }),
  };
}
