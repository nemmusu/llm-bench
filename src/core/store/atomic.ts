import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

export interface AtomicFs {
  writeFile(p: string, data: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  rm(p: string): Promise<void>;
  mkdir(p: string): Promise<void>;
}

const realFs: AtomicFs = {
  writeFile: (p, d) => fs.writeFile(p, d, { encoding: 'utf8', mode: 0o600 }),
  rename: (a, b) => fs.rename(a, b),
  rm: (p) => fs.rm(p, { force: true }),
  mkdir: async (p) => {
    await fs.mkdir(p, { recursive: true });
  },
};

const RETRYABLE = new Set(['EPERM', 'EACCES', 'EBUSY']);

/**
 * Writes `data` to a temp file next to `file` and renames it into place, so readers never see
 * a half-written file. On Windows an antivirus may briefly lock the target: retry a few times.
 */
export async function writeFileAtomic(
  file: string,
  data: string,
  opts: { fs?: AtomicFs; retries?: number; delayMs?: number } = {},
): Promise<void> {
  const afs = opts.fs ?? realFs;
  const retries = opts.retries ?? 6;
  const delay = opts.delayMs ?? 50;
  await afs.mkdir(path.dirname(file));
  const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
  await afs.writeFile(tmp, data);
  for (let attempt = 0; ; attempt++) {
    try {
      await afs.rename(tmp, file);
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code ?? '';
      if (!RETRYABLE.has(code) || attempt >= retries) {
        await afs.rm(tmp);
        throw e;
      }
      await new Promise((r) => setTimeout(r, delay * (attempt + 1)));
    }
  }
}

export async function readJsonFile(file: string): Promise<unknown> {
  return JSON.parse(await fs.readFile(file, 'utf8')) as unknown;
}
