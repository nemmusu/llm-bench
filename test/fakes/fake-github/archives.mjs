// Minimal deterministic zip / tar.gz writers for tests. They can produce hostile entries
// (absolute paths, "..", symlinks pointing outside) that real archivers refuse to create.
import zlib from 'node:zlib';

/**
 * @typedef {object} ArchiveEntry
 * @property {string} name        Entry path as stored (POSIX separators; may be hostile on purpose).
 * @property {string | Buffer} [data]
 * @property {number} [mode]      Unix permission bits (default 0o644, dirs 0o755).
 * @property {'file' | 'dir' | 'symlink' | 'hardlink' | 'fifo'} [type]
 * @property {string} [target]    Link target for symlink/hardlink.
 */

const toBuf = (d) => (Buffer.isBuffer(d) ? d : Buffer.from(d ?? '', 'utf8'));

/**
 * @param {ArchiveEntry[]} entries
 * @returns {Buffer}
 */
export function makeZip(entries) {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const e of entries) {
    const type = e.type ?? (e.name.endsWith('/') ? 'dir' : 'file');
    const name = Buffer.from(e.name, 'utf8');
    const raw = type === 'symlink' ? Buffer.from(e.target ?? '', 'utf8') : type === 'dir' ? Buffer.alloc(0) : toBuf(e.data);
    const deflate = raw.length > 32;
    const body = deflate ? zlib.deflateRawSync(raw) : raw;
    const crc = zlib.crc32(raw);
    const kind = type === 'symlink' ? 0o120000 : type === 'dir' ? 0o040000 : 0o100000;
    const mode = kind | (e.mode ?? (type === 'dir' ? 0o755 : type === 'symlink' ? 0o777 : 0o644));

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(deflate ? 8 : 0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x21, 12); // 1980-01-01
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    parts.push(local, name, body);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE((3 << 8) | 20, 4); // made by: Unix
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(deflate ? 8 : 0, 10);
    cd.writeUInt16LE(0, 12);
    cd.writeUInt16LE(0x21, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(body.length, 20);
    cd.writeUInt32LE(raw.length, 24);
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt16LE(0, 30);
    cd.writeUInt16LE(0, 32);
    cd.writeUInt16LE(0, 34);
    cd.writeUInt16LE(0, 36);
    cd.writeUInt32LE((mode << 16) >>> 0, 38);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, name);
    offset += local.length + name.length + body.length;
  }
  const cdBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cdBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cdBuf, end]);
}

function octal(n, width) {
  return `${n.toString(8).padStart(width - 1, '0')}\0`;
}

/**
 * ustar archive, gzipped.
 * @param {ArchiveEntry[]} entries
 * @returns {Buffer}
 */
export function makeTarGz(entries) {
  const blocks = [];
  for (const e of entries) {
    const type = e.type ?? (e.name.endsWith('/') ? 'dir' : 'file');
    const data = type === 'file' ? toBuf(e.data) : Buffer.alloc(0);
    const h = Buffer.alloc(512);
    let name = e.name;
    let prefix = '';
    if (Buffer.byteLength(name) > 100) {
      const cut = name.lastIndexOf('/', name.length - 1 - 0);
      prefix = name.slice(0, cut);
      name = name.slice(cut + 1);
    }
    h.write(name, 0, 100, 'utf8');
    h.write(octal(e.mode ?? (type === 'dir' ? 0o755 : 0o644), 8), 100, 8, 'ascii');
    h.write(octal(0, 8), 108, 8, 'ascii');
    h.write(octal(0, 8), 116, 8, 'ascii');
    h.write(octal(data.length, 12), 124, 12, 'ascii');
    h.write(octal(0, 12), 136, 12, 'ascii');
    h.fill(0x20, 148, 156);
    const flag = { file: '0', hardlink: '1', symlink: '2', fifo: '6', dir: '5' }[type];
    h.write(flag, 156, 1, 'ascii');
    if (e.target) h.write(e.target, 157, 100, 'utf8');
    h.write('ustar\0', 257, 6, 'ascii');
    h.write('00', 263, 2, 'ascii');
    h.write('root', 265, 32, 'ascii');
    h.write('root', 297, 32, 'ascii');
    if (prefix) h.write(prefix, 345, 155, 'utf8');
    let sum = 0;
    for (const b of h) sum += b;
    h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
    blocks.push(h, data);
    const pad = (512 - (data.length % 512)) % 512;
    if (pad) blocks.push(Buffer.alloc(pad));
  }
  blocks.push(Buffer.alloc(1024));
  return zlib.gzipSync(Buffer.concat(blocks));
}
