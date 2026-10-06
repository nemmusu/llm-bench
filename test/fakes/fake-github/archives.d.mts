export interface ArchiveEntry {
  name: string;
  data?: string | Buffer;
  mode?: number;
  type?: 'file' | 'dir' | 'symlink' | 'hardlink' | 'fifo';
  target?: string;
}

export function makeZip(entries: ArchiveEntry[]): Buffer;
export function makeTarGz(entries: ArchiveEntry[]): Buffer;
