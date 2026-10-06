import { createHash } from 'node:crypto';
import path from 'node:path';
import type { Platform } from '../deps';

/** Absolute path in a canonical form for ids and cache keys (Windows paths are case-insensitive). */
export function normalizePath(p: string, platform: Platform): string {
  const abs = path.resolve(p);
  return platform === 'win32' ? abs.replace(/\//g, '\\').toLowerCase() : abs;
}

/** Stable LocalModel.id: first 16 hex chars of sha256(normalized main path). */
export function modelIdFor(p: string, platform: Platform): string {
  return createHash('sha256').update(normalizePath(p, platform)).digest('hex').slice(0, 16);
}

/** true when `child` is strictly inside `parent` (both already resolved; no symlink checks). */
export function isInside(child: string, parent: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel !== '' && rel.split(/[\\/]/)[0] !== '..' && !path.isAbsolute(rel);
}

/** Cache key for per-file data that is valid while the file is unchanged. */
export function fileKey(p: string, size: number, mtimeMs: number, platform: Platform): string {
  return `${normalizePath(p, platform)}|${size}|${Math.floor(mtimeMs)}`;
}

/** Split GGUF shard name: "model-00001-of-00003.gguf" → { prefix: "model", index: 1, total: 3 }. */
export function parseShard(name: string): { prefix: string; index: number; total: number } | undefined {
  const m = /^(.*)-(\d{5})-of-(\d{5})\.gguf$/i.exec(name);
  if (!m) return undefined;
  return { prefix: m[1] as string, index: Number(m[2]), total: Number(m[3]) };
}

/** Repo ids as HF accepts them: owner/name with letters, digits, "-", "_", ".". */
export const REPO_RE = /^[A-Za-z0-9][\w.-]{0,95}\/[A-Za-z0-9][\w.-]{0,95}$/;

/** A relative path inside a repo that cannot escape the destination folder. */
export function safeRepoPath(p: string): boolean {
  if (p.length === 0 || p.length > 512 || p.startsWith('/') || p.includes('\\') || p.includes('\0')) return false;
  return p.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..' && !/^[a-zA-Z]:$/.test(seg));
}
