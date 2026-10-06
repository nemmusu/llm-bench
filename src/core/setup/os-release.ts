import { promises as fs } from 'node:fs';

/** The fields of /etc/os-release the setup code relies on. */
export interface OsRelease {
  /** Lower-case distro id, e.g. "ubuntu", "debian", "linuxmint". */
  id: string;
  /** ID_LIKE split on spaces, e.g. ["ubuntu", "debian"] on Linux Mint. */
  idLike: string[];
  versionId?: string;
  versionCodename?: string;
  /** Set by Ubuntu and its derivatives; Docker's apt repository is keyed by it. */
  ubuntuCodename?: string;
  prettyName?: string;
}

/** Unquotes a shell-style value: "x", 'x' or bare (os-release(5) allows all three). */
function unquote(v: string): string {
  const m = /^"((?:[^"\\]|\\.)*)"$|^'([^']*)'$/.exec(v);
  if (!m) return v;
  return m[1] !== undefined ? m[1].replace(/\\(.)/g, '$1') : (m[2] as string);
}

/** Parses os-release(5) text; returns undefined when no ID is present. */
export function parseOsRelease(text: string): OsRelease | undefined {
  const kv = new Map<string, string>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
    if (m) kv.set(m[1] as string, unquote((m[2] as string).trim()));
  }
  const id = kv.get('ID')?.toLowerCase();
  if (!id) return undefined;
  const out: OsRelease = { id, idLike: (kv.get('ID_LIKE') ?? '').toLowerCase().split(/\s+/).filter(Boolean) };
  const opt = (key: string, field: 'versionId' | 'versionCodename' | 'ubuntuCodename' | 'prettyName') => {
    const v = kv.get(key);
    if (v) out[field] = v;
  };
  opt('VERSION_ID', 'versionId');
  opt('VERSION_CODENAME', 'versionCodename');
  opt('UBUNTU_CODENAME', 'ubuntuCodename');
  opt('PRETTY_NAME', 'prettyName');
  return out;
}

export type ReadText = (file: string) => Promise<string>;

const defaultRead: ReadText = (file) => fs.readFile(file, 'utf8');

/** /etc/os-release, falling back to /usr/lib/os-release (the spec allows either); undefined when neither parses. */
export async function readOsRelease(read: ReadText = defaultRead): Promise<OsRelease | undefined> {
  for (const file of ['/etc/os-release', '/usr/lib/os-release']) {
    try {
      const parsed = parseOsRelease(await read(file));
      if (parsed) return parsed;
    } catch {
      /* try the next location */
    }
  }
  return undefined;
}

/** Ubuntu or a derivative that declares itself Ubuntu-like (Mint, Pop!_OS, Zorin…). */
export function isUbuntuLike(os: OsRelease): boolean {
  return os.id === 'ubuntu' || os.idLike.includes('ubuntu');
}
