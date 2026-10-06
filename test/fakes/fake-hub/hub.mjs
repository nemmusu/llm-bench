// Fake Hugging Face Hub + CDN for offline tests (vitest via index.ts, E2E via fake-hub.mjs).
//
// Emulates: GET /api/models (search/author/filter/num_parameters/sort/limit + cursor pages), /api/models/{repo}[/revision/{rev}],
// /api/models/{repo}/tree/{rev}?recursive=true (sizes, git oid, lfs sha256, optional paging),
// /{repo}/raw/{rev}/{path}, /{repo}/resolve/{rev}/{path} (302 to a signed URL on a second
// server = another origin, like HF → cdn), and the CDN with Range, throttling, dropped
// connections, expiring signatures, ignored Range and corrupted bytes. Gated repos (401/403 with
// X-Error-Code: GatedRepo), private repos (401), rate limiting (429) and injected failures.

import { createHash, randomBytes } from 'node:crypto';
import http from 'node:http';
import { buildGguf, buildSafetensors, llamaLikeGguf, seededBytes } from './model-files.mjs';

const LFS_EXT = /\.(gguf|safetensors|bin|pth|pt|onnx)$/i;

function sha1(s) {
  return createHash('sha1').update(s).digest('hex');
}

function prepareFile(spec, index) {
  let bytes;
  if (spec.content !== undefined) bytes = typeof spec.content === 'string' ? new Uint8Array(Buffer.from(spec.content, 'utf8')) : spec.content;
  else if (spec.gguf) bytes = buildGguf({ seed: index + 1, ...spec.gguf });
  else if (spec.safetensors) bytes = buildSafetensors({ seed: index + 1, ...spec.safetensors });
  else bytes = seededBytes(spec.seed ?? index + 1, spec.size ?? 1024);
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length);
  const lfs = spec.lfs ?? (LFS_EXT.test(spec.path) || buf.length > 10 * 1024);
  return {
    path: spec.path,
    bytes: buf,
    size: buf.length,
    sha256: createHash('sha256').update(buf).digest('hex'),
    gitOid: createHash('sha1').update(`blob ${buf.length}\0`).update(buf).digest('hex'),
    lfs,
  };
}

function prepareRepo(spec) {
  const files = new Map();
  spec.files.forEach((f, i) => files.set(f.path, prepareFile(f, i)));
  if (spec.readme !== undefined && !files.has('README.md')) files.set('README.md', prepareFile({ path: 'README.md', content: spec.readme }, 999));
  const tags = [...(spec.tags ?? [])];
  const base = spec.baseModel === undefined ? [] : Array.isArray(spec.baseModel) ? spec.baseModel : [spec.baseModel];
  for (const b of base) {
    if (!tags.includes(`base_model:${b}`)) tags.push(`base_model:${b}`);
  }
  if (spec.license && !tags.includes(`license:${spec.license}`)) tags.push(`license:${spec.license}`);
  return {
    id: spec.id,
    sha: spec.sha ?? sha1(spec.id),
    private: spec.private ?? false,
    gated: spec.gated ?? false,
    accepted: spec.accepted ?? false,
    downloads: spec.downloads ?? 0,
    likes: spec.likes ?? 0,
    trendingScore: spec.trendingScore ?? 0,
    lastModified: spec.lastModified ?? '2026-01-01T00:00:00.000Z',
    createdAt: spec.createdAt ?? spec.lastModified ?? '2026-01-01T00:00:00.000Z',
    numParameters: spec.numParameters ?? spec.safetensorsTotal ?? paramsFromId(spec.id),
    pipelineTag: spec.pipelineTag,
    license: spec.license,
    baseModel: spec.baseModel,
    safetensorsTotal: spec.safetensorsTotal,
    tags,
    files,
  };
}

/** "Qwen3-0.6B-GGUF" → 6e8, like HF's numParameters for repos without safetensors metadata. */
function paramsFromId(id) {
  const m = /(\d+(?:\.\d+)?)([MB])(?![a-z])/i.exec(id);
  if (!m) return undefined;
  return Number(m[1]) * (m[2].toUpperCase() === 'B' ? 1e9 : 1e6);
}

/** HF's `num_parameters=min:1B,max:9B` filter as [min, max] parameter counts. */
function paramsRange(v) {
  const out = [0, Infinity];
  for (const part of (v ?? '').split(',')) {
    const m = /^(min|max):(\d+(?:\.\d+)?)([KMBT]?)$/i.exec(part.trim());
    if (!m) continue;
    const scale = { '': 1, K: 1e3, M: 1e6, B: 1e9, T: 1e12 }[m[3].toUpperCase()];
    out[m[1].toLowerCase() === 'min' ? 0 : 1] = Number(m[2]) * scale;
  }
  return out;
}

/** Real-looking demo catalogue: GGUF repos (single + split + mmproj/mtp), safetensors, gated, private. */
export function demoRepos() {
  const qwen = (fileType, seed) => ({ ...llamaLikeGguf({ name: 'Qwen3 0.6B', sizeLabel: '0.6B', fileType }), seed });
  return [
    {
      id: 'ggml-org/Qwen3-0.6B-GGUF',
      downloads: 120000,
      likes: 300,
      trendingScore: 40,
      lastModified: '2026-05-01T10:00:00.000Z',
      license: 'apache-2.0',
      pipelineTag: 'text-generation',
      baseModel: 'Qwen/Qwen3-0.6B',
      tags: ['gguf', 'text-generation', 'base_model:quantized:Qwen/Qwen3-0.6B'],
      readme: '# Qwen3 0.6B GGUF\n\nDemo model card.\n',
      files: [
        { path: 'Qwen3-0.6B-Q4_K_M.gguf', gguf: { ...qwen(15, 11), totalSize: 96 * 1024 } },
        { path: 'Qwen3-0.6B-Q8_0.gguf', gguf: { ...qwen(7, 12), totalSize: 160 * 1024 } },
        { path: 'params', content: '{"temperature": 0.6}' },
      ],
    },
    {
      id: 'unsloth/Demo-31B-it-GGUF',
      downloads: 50000,
      likes: 900,
      trendingScore: 90,
      lastModified: '2026-09-01T10:00:00.000Z',
      license: 'apache-2.0',
      pipelineTag: 'image-text-to-text',
      baseModel: 'google/Demo-31B-it',
      tags: ['gguf', 'base_model:quantized:google/Demo-31B-it'],
      readme: '# Demo 31B\n',
      files: [
        {
          path: 'Q4_K_M/Demo-31B-it-Q4_K_M-00001-of-00002.gguf',
          gguf: {
            ...llamaLikeGguf({
              arch: 'gemma4',
              name: 'Demo-31B-It',
              sizeLabel: '31B',
              layers: 6,
              kvHeads: [16, 16, 4, 16, 16, 4],
              headDim: 512,
              tied: true,
              extra: {
                'gemma4.attention.sliding_window': 1024,
                'gemma4.attention.sliding_window_pattern': [true, true, false, true, true, false],
                'gemma4.attention.key_length_swa': 256,
                'gemma4.attention.value_length_swa': 256,
                'split.count': 2,
              },
            }),
            totalSize: 128 * 1024,
          },
        },
        { path: 'Q4_K_M/Demo-31B-it-Q4_K_M-00002-of-00002.gguf', gguf: { metadata: { 'split.count': 2 }, totalSize: 64 * 1024 } },
        { path: 'Demo-31B-it-Q8_0.gguf', size: 300 * 1024 },
        { path: 'mmproj-F16.gguf', gguf: { metadata: { 'general.architecture': 'clip', 'general.type': 'mmproj' }, totalSize: 16 * 1024 } },
        { path: 'MTP/mtp-Demo-31B-it-Q8_0.gguf', size: 8 * 1024 },
      ],
    },
    {
      id: 'Qwen/Qwen3-0.6B',
      downloads: 900000,
      likes: 800,
      trendingScore: 10,
      lastModified: '2025-07-26T00:00:00.000Z',
      license: 'apache-2.0',
      pipelineTag: 'text-generation',
      safetensorsTotal: 751632384,
      tags: ['transformers', 'safetensors', 'qwen3', 'text-generation'],
      readme: '# Qwen3-0.6B\n',
      files: [
        {
          path: 'config.json',
          content: JSON.stringify({
            architectures: ['Qwen3ForCausalLM'],
            model_type: 'qwen3',
            hidden_size: 1024,
            num_hidden_layers: 28,
            num_attention_heads: 16,
            num_key_value_heads: 8,
            head_dim: 128,
            max_position_embeddings: 40960,
            intermediate_size: 3072,
            vocab_size: 151936,
            torch_dtype: 'bfloat16',
            use_sliding_window: false,
            sliding_window: null,
          }),
        },
        { path: 'generation_config.json', content: '{"do_sample": true}' },
        { path: 'model.safetensors', safetensors: { tensors: { 'model.embed_tokens.weight': { dtype: 'BF16', shape: [64, 32] } }, totalSize: 64 * 1024 } },
        { path: 'tokenizer.json', content: '{"version":"1.0"}' },
        { path: 'tokenizer_config.json', content: '{}' },
        { path: 'merges.txt', content: 'a b\n' },
        { path: 'vocab.json', content: '{}' },
        { path: 'original/consolidated.pth', size: 4096 },
        { path: 'Qwen3-0.6B-F16.gguf', size: 4096 },
      ],
    },
    {
      id: 'google/gated-demo-it',
      gated: 'manual',
      downloads: 7000,
      likes: 70,
      license: 'gemma',
      tags: ['gguf'],
      readme: '# Gated\n',
      files: [{ path: 'gated-demo-it-Q4_K_M.gguf', gguf: { ...llamaLikeGguf({ name: 'Gated' }), totalSize: 32 * 1024 } }],
    },
    {
      id: 'private-org/secret-model',
      private: true,
      tags: ['gguf'],
      files: [{ path: 'secret-Q4_K_M.gguf', size: 2048 }],
    },
  ];
}

function sendJson(res, status, body, headers = {}) {
  const data = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': data.length, ...headers });
  res.end(data);
}

function sendError(res, status, code, message) {
  const headers = { 'x-error-message': message };
  if (code) headers['x-error-code'] = code;
  sendJson(res, status, { error: message }, headers);
}

/**
 * @param {import('./hub.d.mts').FakeHubOptions} [opts]
 * @returns {Promise<import('./hub.d.mts').FakeHub>}
 */
export async function startFakeHub(opts = {}) {
  const repos = new Map();
  for (const spec of opts.repos ?? demoRepos()) repos.set(spec.id, prepareRepo(spec));
  const tokens = new Set(opts.tokens ?? ['hf_test_token']);
  const behavior = {
    throttleBytesPerSec: 0,
    dropAfterBytes: 0,
    dropTimes: 0,
    tokenTtlMs: 3_600_000,
    ignoreRange: false,
    rateLimitNext: 0,
    failNext: undefined,
    corrupt: [],
    treePageSize: 0,
    ...opts.behavior,
  };
  const signed = new Map();
  const requests = [];
  let hubUrl = '';
  let cdnUrl = '';

  function authOf(req) {
    const h = req.headers.authorization;
    if (!h) return { token: undefined, valid: false };
    const token = h.startsWith('Bearer ') ? h.slice(7) : '';
    return { token, valid: tokens.has(token) };
  }

  /** null when access is granted, else sends the HF-like error and returns true. */
  function denied(res, repo, auth, kind, repoId) {
    if (auth.token !== undefined && !auth.valid) {
      sendError(res, 401, undefined, 'Invalid credentials in Authorization header');
      return true;
    }
    if (!repo) {
      if (auth.valid) sendError(res, 404, 'RepoNotFound', `Repository not found: ${repoId}`);
      else sendError(res, 401, undefined, 'Invalid username or password.');
      return true;
    }
    if (repo.private && !auth.valid) {
      sendError(res, 401, undefined, 'Invalid username or password.');
      return true;
    }
    if (repo.gated && kind === 'file') {
      if (!auth.valid) {
        sendError(res, 401, 'GatedRepo', `Access to model ${repo.id} is restricted. You must have access to it and be authenticated to access it. Please log in.`);
        return true;
      }
      if (!repo.accepted) {
        sendError(res, 403, 'GatedRepo', `Access to model ${repo.id} is restricted and you are not in the authorized list.`);
        return true;
      }
    }
    return false;
  }

  function revisionOk(res, repo, rev) {
    if (rev === 'main' || rev === repo.sha) return true;
    sendError(res, 404, 'RevisionNotFound', `Invalid rev id: ${rev}`);
    return false;
  }

  function summary(repo) {
    const out = {
      _id: repo.sha.slice(0, 24),
      id: repo.id,
      downloads: repo.downloads,
      likes: repo.likes,
      trendingScore: repo.trendingScore,
      lastModified: repo.lastModified,
      gated: repo.gated,
      tags: repo.tags,
      cardData: {},
    };
    if (repo.pipelineTag) out.pipeline_tag = repo.pipelineTag;
    if (repo.license) out.cardData.license = repo.license;
    if (repo.baseModel) out.cardData.base_model = repo.baseModel;
    if (repo.safetensorsTotal) out.safetensors = { parameters: { BF16: repo.safetensorsTotal }, total: repo.safetensorsTotal };
    return out;
  }

  /** Writes [start, end] of a file with throttling, drops and corruption as configured. */
  async function sendBytes(req, res, repo, file, extraHeaders) {
    const size = file.size;
    let start = 0;
    let end = size - 1;
    let status = 200;
    const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '');
    if (range && !behavior.ignoreRange) {
      start = Number(range[1]);
      end = range[2] === '' ? size - 1 : Math.min(Number(range[2]), size - 1);
      if (start >= size) {
        res.writeHead(416, { 'content-range': `bytes */${size}` });
        res.end();
        return;
      }
      status = 206;
    }
    let body = file.bytes;
    if (behavior.corrupt.includes(`${repo.id}/${file.path}`)) {
      body = Buffer.from(body);
      body[body.length - 1] ^= 0xff;
    }
    const headers = {
      'content-type': 'application/octet-stream',
      'content-length': end - start + 1,
      'accept-ranges': 'bytes',
      etag: `"${file.lfs ? file.sha256 : file.gitOid}"`,
      ...extraHeaders,
    };
    if (status === 206) headers['content-range'] = `bytes ${start}-${end}/${size}`;
    res.writeHead(status, headers);
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    const chunk = 16 * 1024;
    let sent = 0;
    const drop = behavior.dropAfterBytes > 0 && behavior.dropTimes > 0;
    if (drop) behavior.dropTimes--;
    for (let pos = start; pos <= end; pos += chunk) {
      if (res.destroyed) return;
      const piece = body.subarray(pos, Math.min(end + 1, pos + chunk));
      if (drop && sent + piece.length > behavior.dropAfterBytes) {
        res.write(piece.subarray(0, Math.max(0, behavior.dropAfterBytes - sent)));
        await new Promise((r) => setTimeout(r, 5));
        res.socket?.destroy();
        return;
      }
      const ok = res.write(piece);
      sent += piece.length;
      if (behavior.throttleBytesPerSec > 0) await new Promise((r) => setTimeout(r, (piece.length / behavior.throttleBytesPerSec) * 1000));
      else if (!ok) await new Promise((r) => res.once('drain', r));
    }
    res.end();
  }

  async function hubHandler(req, res) {
    const url = new URL(req.url, hubUrl);
    requests.push({ method: req.method, url: url.pathname + url.search, headers: { ...req.headers }, origin: 'hub' });
    if (behavior.rateLimitNext > 0) {
      behavior.rateLimitNext--;
      sendError(res, 429, undefined, 'Rate limited');
      return;
    }
    const fail = behavior.failNext;
    if (fail && fail.times > 0 && (!fail.match || url.pathname.includes(fail.match))) {
      fail.times--;
      sendError(res, fail.status, undefined, 'Injected failure');
      return;
    }
    const auth = authOf(req);
    const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);

    if (parts[0] === 'api' && parts[1] === 'models') {
      if (parts.length === 2) {
        const search = (url.searchParams.get('search') ?? '').toLowerCase();
        const author = url.searchParams.get('author');
        const filters = url.searchParams.getAll('filter');
        const sort = url.searchParams.get('sort') ?? 'downloads';
        const limit = Number(url.searchParams.get('limit') ?? 50);
        const cursor = Number(url.searchParams.get('cursor') ?? 0);
        let list = [...repos.values()].filter((r) => !r.private);
        if (search) list = list.filter((r) => r.id.toLowerCase().includes(search));
        if (author) list = list.filter((r) => r.id.startsWith(`${author}/`));
        for (const f of filters) list = list.filter((r) => r.tags.includes(f));
        if (url.searchParams.has('num_parameters')) {
          // Like HF: repos without a known parameter count never match a size filter.
          const [min, max] = paramsRange(url.searchParams.get('num_parameters'));
          list = list.filter((r) => r.numParameters !== undefined && r.numParameters >= min && r.numParameters <= max);
        }
        const key = { downloads: 'downloads', likes: 'likes', lastModified: 'lastModified', createdAt: 'createdAt', trendingScore: 'trendingScore' }[sort] ?? 'downloads';
        list.sort((a, b) => (a[key] < b[key] ? 1 : a[key] > b[key] ? -1 : a.id.localeCompare(b.id)));
        const headers = {};
        if (cursor + limit < list.length) {
          // HF's cursor is opaque; an offset is enough here.
          const next = new URL(url);
          next.searchParams.set('cursor', String(cursor + limit));
          headers.link = `<${next.toString()}>; rel="next"`;
        }
        sendJson(res, 200, list.slice(cursor, cursor + limit).map(summary), headers);
        return;
      }
      const repoId = `${parts[2]}/${parts[3]}`;
      const repo = repos.get(repoId);
      if (denied(res, repo, auth, 'meta', repoId)) return;
      if (parts.length === 4 || (parts[4] === 'revision' && parts.length === 6)) {
        if (parts[5] !== undefined && !revisionOk(res, repo, parts[5])) return;
        sendJson(res, 200, {
          ...summary(repo),
          modelId: repo.id,
          author: repo.id.split('/')[0],
          sha: repo.sha,
          private: repo.private,
          siblings: [...repo.files.keys()].map((rfilename) => ({ rfilename })),
        });
        return;
      }
      if (parts[4] === 'tree' && parts[5] !== undefined) {
        if (!revisionOk(res, repo, parts[5])) return;
        const recursive = url.searchParams.get('recursive') === 'true';
        const entries = [];
        const dirs = new Set();
        for (const f of repo.files.values()) {
          const segs = f.path.split('/');
          if (!recursive && segs.length > 1) {
            dirs.add(segs[0]);
            continue;
          }
          for (let i = 1; i < segs.length; i++) dirs.add(segs.slice(0, i).join('/'));
          const e = { type: 'file', oid: f.gitOid, size: f.lfs ? f.size : f.size, path: f.path };
          if (f.lfs) e.lfs = { oid: f.sha256, size: f.size, pointerSize: 135 };
          entries.push(e);
        }
        const all = [...[...dirs].map((d) => ({ type: 'directory', oid: sha1(d), size: 0, path: d })), ...entries];
        const pageSize = behavior.treePageSize;
        if (pageSize > 0) {
          const cursor = Number(url.searchParams.get('cursor') ?? 0);
          const page = all.slice(cursor, cursor + pageSize);
          const headers = {};
          if (cursor + pageSize < all.length) {
            const next = new URL(url);
            next.searchParams.set('cursor', String(cursor + pageSize));
            headers.link = `<${next.toString()}>; rel="next"`;
          }
          sendJson(res, 200, page, headers);
          return;
        }
        sendJson(res, 200, all);
        return;
      }
      sendError(res, 404, undefined, 'Not found');
      return;
    }

    if (parts.length >= 5 && (parts[2] === 'raw' || parts[2] === 'resolve')) {
      const repoId = `${parts[0]}/${parts[1]}`;
      const repo = repos.get(repoId);
      const filePath = parts.slice(4).join('/');
      const isReadme = parts[2] === 'raw' && filePath === 'README.md';
      if (denied(res, repo, auth, isReadme ? 'meta' : 'file', repoId)) return;
      if (!revisionOk(res, repo, parts[3])) return;
      const file = repo.files.get(filePath);
      if (!file) {
        sendError(res, 404, 'EntryNotFound', 'Entry not found');
        return;
      }
      const commonHeaders = { 'x-repo-commit': repo.sha };
      if (parts[2] === 'resolve' && file.lfs) {
        const token = randomBytes(12).toString('hex');
        signed.set(token, { repo: repo.id, path: file.path, exp: Date.now() + behavior.tokenTtlMs });
        res.writeHead(302, {
          location: `${cdnUrl}/cdn/${token}/${file.path.split('/').map(encodeURIComponent).join('/')}`,
          'x-linked-size': file.size,
          'x-linked-etag': `"${file.sha256}"`,
          ...commonHeaders,
        });
        res.end();
        return;
      }
      await sendBytes(req, res, repo, file, commonHeaders);
      return;
    }
    sendError(res, 404, undefined, 'Not found');
  }

  async function cdnHandler(req, res) {
    const url = new URL(req.url, cdnUrl);
    requests.push({ method: req.method, url: url.pathname + url.search, headers: { ...req.headers }, origin: 'cdn' });
    const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    const grant = parts[0] === 'cdn' ? signed.get(parts[1]) : undefined;
    if (!grant || Date.now() > grant.exp) {
      res.writeHead(403, { 'content-type': 'text/plain' });
      res.end('Request has expired');
      return;
    }
    const repo = repos.get(grant.repo);
    const fail = behavior.failNext;
    if (fail && fail.times > 0 && fail.match === 'cdn') {
      fail.times--;
      res.writeHead(fail.status, { 'content-type': 'text/plain' });
      res.end('Injected CDN failure');
      return;
    }
    await sendBytes(req, res, repo, repo.files.get(grant.path), {});
  }

  const wrap = (fn) => (req, res) => {
    fn(req, res).catch((e) => {
      if (!res.headersSent) sendError(res, 500, undefined, String(e?.message ?? e));
      else res.destroy();
    });
  };
  const hubServer = http.createServer(wrap(hubHandler));
  const cdnServer = http.createServer(wrap(cdnHandler));
  const listen = (server, port) =>
    new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => resolve(server.address().port));
    });
  const hubPort = await listen(hubServer, opts.port ?? 0);
  const cdnPort = await listen(cdnServer, opts.cdnPort ?? 0);
  hubUrl = `http://127.0.0.1:${hubPort}`;
  cdnUrl = `http://127.0.0.1:${cdnPort}`;

  const close = () =>
    Promise.all(
      [hubServer, cdnServer].map(
        (s) =>
          new Promise((resolve) => {
            s.close(() => resolve());
            s.closeAllConnections?.();
          }),
      ),
    ).then(() => undefined);

  return {
    url: hubUrl,
    cdnUrl,
    behavior,
    requests,
    close,
    expireSignedUrls() {
      for (const g of signed.values()) g.exp = 0;
    },
    file(repoId, filePath) {
      const f = repos.get(repoId)?.files.get(filePath);
      if (!f) throw new Error(`no such fake file ${repoId}/${filePath}`);
      return { bytes: f.bytes, size: f.size, sha256: f.sha256, lfs: f.lfs };
    },
    repo(repoId) {
      const r = repos.get(repoId);
      if (!r) throw new Error(`no such fake repo ${repoId}`);
      return { id: r.id, sha: r.sha, files: [...r.files.keys()] };
    },
    addRepo(spec) {
      repos.set(spec.id, prepareRepo(spec));
    },
    setAccepted(repoId, accepted) {
      const r = repos.get(repoId);
      if (r) r.accepted = accepted;
    },
  };
}
