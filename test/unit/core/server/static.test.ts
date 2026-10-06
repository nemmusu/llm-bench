import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { contentType, resolveInside, serveStatic } from '../../../../src/core/server/static';
import { tempDir } from './helpers';

describe('resolveInside', () => {
  const root = path.resolve('/srv/ui');
  it('resolves normal paths and the root to index.html', () => {
    expect(resolveInside(root, '/')).toBe(path.join(root, 'index.html'));
    expect(resolveInside(root, '/assets/a.js')).toBe(path.join(root, 'assets', 'a.js'));
  });
  it('refuses traversal, NUL bytes and malformed escapes', () => {
    expect(resolveInside(root, '/../secret')).toBeUndefined();
    expect(resolveInside(root, '/%2e%2e/%2e%2e/etc/passwd')).toBeUndefined();
    expect(resolveInside(root, '/a%00b')).toBeUndefined();
    expect(resolveInside(root, '/%E0%A4%A')).toBeUndefined();
  });
});

describe('contentType', () => {
  it('maps known extensions and defaults to octet-stream', () => {
    expect(contentType('a.HTML')).toContain('text/html');
    expect(contentType('font.woff2')).toBe('font/woff2');
    expect(contentType('blob.bin')).toBe('application/octet-stream');
  });
});

describe('serveStatic', () => {
  let t: ReturnType<typeof tempDir>;
  beforeEach(() => {
    t = tempDir();
  });
  afterEach(() => t.cleanup());

  it('serves directory indexes', async () => {
    mkdirSync(path.join(t.dir, 'docs'));
    writeFileSync(path.join(t.dir, 'docs', 'index.html'), 'docs');
    const res = await serveStatic(t.dir, '/docs');
    expect(await res.text()).toBe('docs');
  });

  it('returns 404 for missing files with an extension', async () => {
    const res = await serveStatic(t.dir, '/missing.js');
    expect(res.status).toBe(404);
  });

  it('returns 404 when the UI is not built', async () => {
    const res = await serveStatic(t.dir, '/some/route');
    expect(res.status).toBe(404);
    expect(await res.text()).toBe('UI not built');
  });

  it('returns 400 for paths escaping the root', async () => {
    const res = await serveStatic(t.dir, '/%2e%2e/x');
    expect(res.status).toBe(400);
  });
});
