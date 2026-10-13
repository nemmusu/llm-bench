/**
 * A file system in memory for the rename migration (src/main/migrate.ts): the sync and the promise
 * parts it uses, with failures on demand. Never the real %APPDATA%\GPU Bench or ~/.config.
 */
import path from 'node:path';
import type { LegacyAsyncFs, LegacyStat, LegacySyncFs } from '../../../src/main/migrate';

type Node = { kind: 'dir' } | { kind: 'file'; data: string; size?: number } | { kind: 'link'; target: string };

export function fsError(code: string, op: string, p: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: ${op} '${p}'`), { code });
}

export class FakeFs implements LegacySyncFs, LegacyAsyncFs {
  readonly nodes = new Map<string, Node>();
  /** "op path" → error code: that call fails (op: rename, rmdir, mkdir, open, cp, copyFile, readFile, writeFile, lstat). */
  readonly failures = new Map<string, string>();
  /** Files held open by another process without sharing (Windows): open fails with EBUSY. */
  readonly busy = new Set<string>();
  readonly calls: string[] = [];

  private key(p: string): string {
    return path.resolve(p);
  }

  private fail(op: string, p: string): void {
    this.calls.push(`${op} ${p}`);
    const code = this.failures.get(`${op} ${this.key(p)}`);
    if (code) throw fsError(code, op, p);
  }

  private node(p: string, op: string): Node {
    const n = this.nodes.get(this.key(p));
    if (!n) throw fsError('ENOENT', op, p);
    return n;
  }

  private children(p: string): string[] {
    const k = this.key(p);
    const out: string[] = [];
    for (const key of this.nodes.keys()) if (path.dirname(key) === k && key !== k) out.push(path.basename(key));
    return out.sort();
  }

  private ensureParents(p: string): void {
    let d = path.dirname(this.key(p));
    while (!this.nodes.has(d) && path.dirname(d) !== d) {
      this.nodes.set(d, { kind: 'dir' });
      d = path.dirname(d);
    }
  }

  dir(p: string): this {
    this.ensureParents(p);
    this.nodes.set(this.key(p), { kind: 'dir' });
    return this;
  }

  file(p: string, data: string, size?: number): this {
    this.ensureParents(p);
    this.nodes.set(this.key(p), { kind: 'file', data, ...(size !== undefined ? { size } : {}) });
    return this;
  }

  link(p: string, target: string): this {
    this.ensureParents(p);
    this.nodes.set(this.key(p), { kind: 'link', target });
    return this;
  }

  text(p: string): string | undefined {
    const n = this.nodes.get(this.key(p));
    return n?.kind === 'file' ? n.data : undefined;
  }

  has(p: string): boolean {
    return this.nodes.has(this.key(p));
  }

  /** Every path under `p` (relative, sorted). */
  tree(p: string): string[] {
    const k = this.key(p);
    return [...this.nodes.keys()].filter((x) => x.startsWith(k + path.sep)).map((x) => path.relative(k, x).replaceAll('\\', '/')).sort();
  }

  // ---- sync ----
  existsSync(p: string): boolean {
    return this.nodes.has(this.key(p));
  }

  readdirSync(p: string): string[] {
    const n = this.node(p, 'scandir');
    if (n.kind !== 'dir') throw fsError('ENOTDIR', 'scandir', p);
    return this.children(p);
  }

  rmdirSync(p: string): void {
    this.fail('rmdir', p);
    this.node(p, 'rmdir');
    if (this.children(p).length) throw fsError('ENOTEMPTY', 'rmdir', p);
    this.nodes.delete(this.key(p));
  }

  renameSync(from: string, to: string): void {
    this.fail('rename', from);
    this.node(from, 'rename');
    if (this.nodes.has(this.key(to))) throw fsError('EPERM', 'rename', from);
    const a = this.key(from);
    const b = this.key(to);
    for (const [k, v] of [...this.nodes]) {
      if (k === a || k.startsWith(a + path.sep)) {
        this.nodes.delete(k);
        this.nodes.set(b + k.slice(a.length), v);
      }
    }
  }

  mkdirSync(p: string): unknown {
    this.fail('mkdir', p);
    this.dir(p);
    return undefined;
  }

  copyFileSync(from: string, to: string): void {
    this.fail('copyFile', from);
    const n = this.node(from, 'copyfile');
    this.ensureParents(to);
    this.nodes.set(this.key(to), { ...n });
  }

  readlinkSync(p: string): string {
    const n = this.node(p, 'readlink');
    if (n.kind !== 'link') throw fsError('EINVAL', 'readlink', p);
    return n.target;
  }

  openSync(p: string): number {
    this.fail('open', p);
    this.node(p, 'open');
    if (this.busy.has(this.key(p))) throw fsError('EBUSY', 'open', p);
    return 7;
  }

  closeSync(): void {}

  // ---- promises ----
  async readFile(p: string): Promise<Buffer> {
    this.fail('readFile', p);
    const n = this.node(p, 'open');
    if (n.kind !== 'file') throw fsError('EISDIR', 'read', p);
    return Buffer.from(n.data);
  }

  async writeFile(p: string, data: string): Promise<void> {
    this.fail('writeFile', p);
    this.file(p, data);
  }

  async readdir(p: string): Promise<string[]> {
    return this.readdirSync(p);
  }

  async lstat(p: string): Promise<LegacyStat> {
    this.fail('lstat', p);
    const n = this.node(p, 'lstat');
    const size = n.kind === 'file' ? (n.size ?? n.data.length) : n.kind === 'link' ? n.target.length : 0;
    return { size, isFile: () => n.kind === 'file', isDirectory: () => n.kind === 'dir' };
  }

  /** Like fs.cp with force: false: what is already at the destination stays. */
  async cp(from: string, to: string): Promise<void> {
    this.fail('cp', from);
    const a = this.key(from);
    const b = this.key(to);
    this.node(from, 'cp');
    for (const [k, v] of [...this.nodes]) {
      if (k !== a && !k.startsWith(a + path.sep)) continue;
      const dest = b + k.slice(a.length);
      if (this.nodes.has(dest)) continue;
      this.ensureParents(dest);
      this.nodes.set(dest, { ...v });
    }
  }
}
