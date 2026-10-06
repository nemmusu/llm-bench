import { promises as fs } from 'node:fs';
import path from 'node:path';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.txt': 'text/plain; charset=utf-8',
};

export function contentType(file: string): string {
  return TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
}

/**
 * Resolves a URL path inside `root`, refusing anything that escapes it (../, absolute, drive letters).
 * Returns undefined for invalid paths.
 */
export function resolveInside(root: string, urlPath: string): string | undefined {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return undefined;
  }
  if (decoded.includes('\0')) return undefined;
  const rel = decoded.replace(/^\/+/, '') || 'index.html';
  const full = path.resolve(root, rel);
  const rootWithSep = path.resolve(root) + path.sep;
  if (full !== path.resolve(root) && !full.startsWith(rootWithSep)) return undefined;
  return full;
}

/** Serves a built single-page app: existing files as-is, everything else falls back to index.html. */
export async function serveStatic(root: string, urlPath: string): Promise<Response> {
  const file = resolveInside(root, urlPath);
  if (!file) return new Response('Bad path', { status: 400 });
  let target = file;
  let body: Buffer;
  try {
    const st = await fs.stat(target);
    if (st.isDirectory()) target = path.join(target, 'index.html');
    body = await fs.readFile(target);
  } catch {
    if (path.extname(file)) return new Response('Not found', { status: 404 });
    target = path.join(root, 'index.html');
    try {
      body = await fs.readFile(target);
    } catch {
      return new Response('UI not built', { status: 404 });
    }
  }
  const immutable = /[.-][A-Za-z0-9_-]{8}\.(js|css|woff2)$/.test(target);
  return new Response(new Uint8Array(body), {
    status: 200,
    headers: {
      'content-type': contentType(target),
      'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
    },
  });
}
