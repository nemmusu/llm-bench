import { createWriteStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';
import { extract as tarExtract, type ReadEntry } from 'tar';
import yauzl from 'yauzl';
import { AppError } from '../../contract/errors';

export type SymlinkFn = (target: string, linkPath: string) => Promise<void>;

export interface ExtractOptions {
  /** Injected for tests (Windows needs a privilege to create symlinks). */
  symlink?: SymlinkFn;
}

/** Archive entry names are POSIX-relative; anything absolute or climbing out is hostile (zip-slip). */
export function isUnsafeEntryName(name: string): boolean {
  const n = name.replace(/\\/g, '/');
  if (n.startsWith('/') || /^[A-Za-z]:/.test(n)) return true;
  return n.split('/').includes('..');
}

export function isInside(root: string, p: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(p));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** Joins an archive entry name under root, refusing escapes. */
export function safeJoin(root: string, name: string): string {
  const target = path.resolve(root, name.replace(/\\/g, '/'));
  if (isUnsafeEntryName(name) || !isInside(root, target)) throw unsafe(name);
  return target;
}

/**
 * Creates a symlink only when it stays inside `root` (relative targets resolving inside).
 * Returns false when skipped: outside targets, or the OS refused (Windows without the privilege).
 */
export async function linkInside(root: string, linkPath: string, target: string, symlink: SymlinkFn): Promise<boolean> {
  if (path.isAbsolute(target) || /^[A-Za-z]:/.test(target)) return false;
  if (!isInside(root, path.resolve(path.dirname(linkPath), target))) return false;
  try {
    await fs.mkdir(path.dirname(linkPath), { recursive: true });
    await symlink(target, linkPath);
    return true;
  } catch {
    return false;
  }
}

const defaultSymlink: SymlinkFn = (target, linkPath) => fs.symlink(target, linkPath);

export async function extractArchive(file: string, destDir: string, opts: ExtractOptions = {}): Promise<void> {
  if (/\.zip$/i.test(file)) return extractZip(file, destDir, opts);
  if (/\.(tar\.gz|tgz)$/i.test(file)) return extractTarGz(file, destDir, opts);
  throw new AppError('ENGINE_INSTALL_FAILED', `Unsupported archive type: ${path.basename(file)}`, {
    params: { reason: 'unsupported-archive' },
  });
}

const S_IFMT = 0o170000;
/** Regular files and folders only: devices, FIFOs and the like are never created. */
const EXTRACTED_TYPES = new Set<string>(['File', 'OldFile', 'ContiguousFile', 'Directory']);
const S_IFLNK = 0o120000;

export async function extractZip(file: string, destDir: string, opts: ExtractOptions = {}): Promise<void> {
  const symlink = opts.symlink ?? defaultSymlink;
  await fs.mkdir(destDir, { recursive: true });
  let zip: yauzl.ZipFile;
  try {
    zip = await yauzl.openPromise(file, { lazyEntries: true, autoClose: true, validateEntrySizes: true });
  } catch (e) {
    throw corrupt(file, e);
  }
  try {
    // yauzl itself rejects absolute and `..` names while iterating ("absolute path", "invalid relative path").
    for await (const entry of zip.eachEntry()) {
      const name = entry.fileName;
      const target = safeJoin(destDir, name);
      if (name.endsWith('/')) {
        await fs.mkdir(target, { recursive: true });
        continue;
      }
      const unixMode = (entry.externalFileAttributes >>> 16) & 0xffff;
      const stream = await zip.openReadStreamPromise(entry);
      if ((unixMode & S_IFMT) === S_IFLNK) {
        await linkInside(destDir, target, (await readAll(stream)).toString('utf8'), symlink);
        continue;
      }
      await fs.mkdir(path.dirname(target), { recursive: true });
      await pipeline(stream, createWriteStream(target));
    }
  } catch (e) {
    // Leaving the for-await calls the iterator's return(), which closes the file (autoClose).
    throw corrupt(file, e);
  }
}

export async function extractTarGz(file: string, destDir: string, opts: ExtractOptions = {}): Promise<void> {
  const symlink = opts.symlink ?? defaultSymlink;
  await fs.mkdir(destDir, { recursive: true });
  const violations: string[] = [];
  const links: { name: string; target: string }[] = [];
  try {
    await tarExtract({
      file,
      cwd: destDir,
      strict: true,
      preservePaths: false,
      preserveOwner: false,
      filter: (name, entry) => {
        const e = entry as ReadEntry;
        if (isUnsafeEntryName(name)) {
          violations.push(name);
          return false;
        }
        // Symlinks are created by us afterwards, and only when they stay inside destDir.
        if (e.type === 'SymbolicLink') {
          links.push({ name, target: String(e.linkpath) });
          return false;
        }
        if (e.type === 'Link') return !isUnsafeEntryName(String(e.linkpath));
        return EXTRACTED_TYPES.has(e.type);
      },
    });
  } catch (e) {
    throw corrupt(file, e);
  }
  if (violations.length > 0) throw unsafe(violations[0] as string);
  for (const l of links) await linkInside(destDir, safeJoin(destDir, l.name), l.target, symlink);
}

async function readAll(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

function unsafe(name: string): AppError {
  return new AppError('ENGINE_INSTALL_FAILED', `Archive entry escapes the target folder: ${name}`, {
    params: { reason: 'unsafe-archive', entry: name },
  });
}

function corrupt(file: string, e: unknown): AppError {
  const msg = String(e);
  // yauzl reports hostile names itself; keep them distinguishable from plain corruption.
  if (/absolute path|invalid relative path|escapes the target folder/.test(msg)) {
    return new AppError('ENGINE_INSTALL_FAILED', msg, { params: { reason: 'unsafe-archive' }, cause: e });
  }
  return new AppError('ENGINE_INSTALL_FAILED', `Cannot extract ${path.basename(file)}: ${msg}`, {
    params: { reason: 'corrupt-archive' },
    cause: e,
  });
}
