import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileKey, isInside, libraryPath, modelIdFor, normalizePath, parseShard, REPO_RE, repoDir, safeRepoPath } from '../../../../src/core/models/paths';

describe('paths helpers', () => {
  it('lays out downloads as <modelsDir>/<owner>/<name>/<path in repo>', () => {
    const lib = path.resolve('models');
    expect(repoDir(lib, 'Qwen/Qwen3-4B-GGUF')).toBe(path.join(lib, 'Qwen', 'Qwen3-4B-GGUF'));
    expect(libraryPath(lib, 'unsloth/Demo-GGUF', 'Q4_K_M/d-00001-of-00002.gguf')).toBe(path.join(lib, 'unsloth', 'Demo-GGUF', 'Q4_K_M', 'd-00001-of-00002.gguf'));
  });

  it('normalizes Windows paths case-insensitively and keeps POSIX paths as is', () => {
    const abs = path.resolve('Some/Dir/File.GGUF');
    expect(normalizePath('Some/Dir/File.GGUF', 'win32')).toBe(abs.replace(/\//g, '\\').toLowerCase());
    expect(normalizePath('Some/Dir/File.GGUF', 'linux')).toBe(abs);
  });

  it('derives stable 16-hex model ids', () => {
    const id = modelIdFor('C:/models/A.gguf', 'win32');
    expect(id).toMatch(/^[0-9a-f]{16}$/);
    expect(modelIdFor('C:/MODELS/a.gguf', 'win32')).toBe(id);
    expect(modelIdFor('/m/A.gguf', 'linux')).not.toBe(modelIdFor('/m/a.gguf', 'linux'));
  });

  it('tells whether a path is strictly inside a folder', () => {
    const root = path.resolve('lib');
    expect(isInside(path.join(root, 'a', 'b.gguf'), root)).toBe(true);
    expect(isInside(root, root)).toBe(false);
    expect(isInside(path.resolve('lib-other', 'x'), root)).toBe(false);
    expect(isInside(path.resolve('x'), root)).toBe(false);
    expect(isInside(path.join(root, '..foo'), root)).toBe(true);
  });

  it('builds file cache keys', () => {
    expect(fileKey('/a', 5, 12.9, 'linux')).toBe(`${path.resolve('/a')}|5|12`);
  });

  it('parses split shard names', () => {
    expect(parseShard('Model-Q4_K_M-00001-of-00003.gguf')).toEqual({ prefix: 'Model-Q4_K_M', index: 1, total: 3 });
    expect(parseShard('model.gguf')).toBeUndefined();
  });

  it('validates repo ids and repo-relative paths', () => {
    expect(REPO_RE.test('Qwen/Qwen3-4B-GGUF')).toBe(true);
    expect(REPO_RE.test('a/b/c')).toBe(false);
    expect(REPO_RE.test('../x')).toBe(false);
    expect(safeRepoPath('Q4_K_M/model-00001-of-00002.gguf')).toBe(true);
    for (const bad of ['', '/abs', '..', 'a/../b', 'a//b', './a', 'a\\b', 'C:/x', 'x\0y', 'a'.repeat(513)]) expect(safeRepoPath(bad)).toBe(false);
  });
});
