/** The manifest at the start of a .ninfer file: read without touching the weights, leniently. */
import { afterAll, describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { NINFER_MANIFEST_MAX, parseNinferContainer, parseNinferEmbeddedManifest } from '../../../../src/contract/formats';
import { readNinferHeader } from '../../../../src/core/models/ninfer-header';
import { buildNinfer } from '../../../fakes/fake-hub/model-files.mjs';
import { tempDir } from './helpers';

const t = tempDir();
afterAll(() => t.cleanup());

const file = (name: string, bytes: Uint8Array | Buffer) => {
  const p = path.join(t.dir, name);
  writeFileSync(p, bytes);
  return p;
};

const head = (magic: string, version: [number, number], length: bigint): Uint8Array => {
  const b = Buffer.alloc(32);
  b.write(magic, 0, 'latin1');
  b[6] = version[0];
  b[7] = version[1];
  b.writeBigUInt64LE(length, 8);
  return new Uint8Array(b);
};

describe('the start of a .ninfer file', () => {
  it('a GGUF-NInfer artifact: container 3, its name, parts, and the layouts only NInfer-all reads', async () => {
    const p = file('gguf.ninfer', buildNinfer({ name: 'qwen3.8-27b-coder390-q6k-mtp', components: ['text', 'mtp', 'vision'], layouts: ['gguf_blocks_v1', 'contiguous_le_v1', 'gguf_blocks_v1'], totalSize: 64 * 1024 }));
    expect(await readNinferHeader(p)).toEqual({
      containerVersion: 3,
      name: 'qwen3.8-27b-coder390-q6k-mtp',
      components: ['text', 'mtp', 'vision'],
      layouts: ['contiguous_le_v1', 'gguf_blocks_v1'],
      formats: ['bf16', 'gguf_q6_k'],
      // GGUF-NInfer artifacts carry no optimized proposal head (--lm-head-draft would stop the launch).
      proposalHead: false,
    });
    // NInfer's own artifacts store it in the text model.
    expect(await readNinferHeader(file('official.ninfer', buildNinfer({ components: ['text', 'vision', 'mtp', 'dflash2'] })))).toMatchObject({ proposalHead: true });
  });

  it('not one, cut short, a manifest that is not JSON or says nothing: none', async () => {
    expect(await readNinferHeader(path.join(t.dir, 'missing.ninfer'))).toBeUndefined();
    expect(await readNinferHeader(file('zeros.ninfer', Buffer.alloc(4096)))).toBeUndefined();
    expect(await readNinferHeader(file('short.ninfer', Buffer.from('NINFER')))).toBeUndefined();
    // The manifest goes past the end of the file.
    expect(await readNinferHeader(file('cut.ninfer', Buffer.concat([head('NINFER', [0, 3], 1000n), Buffer.from('{"objects":[]}')])))).toBeUndefined();
    const json = (text: string) => Buffer.concat([head('NINFER', [0, 3], BigInt(Buffer.byteLength(text))), Buffer.from(text)]);
    expect(await readNinferHeader(file('bad.ninfer', json('{not json')))).toBeUndefined();
    expect(await readNinferHeader(file('none.ninfer', json('{"components":{}}')))).toBeUndefined();
    // Bare: no name, odd objects and components skipped.
    expect(await readNinferHeader(file('bare.ninfer', json('{"objects":[null,{"layout":""},{"layout":"x","format":1},{"format":"bf16"}],"components":[]}')))).toEqual({
      containerVersion: 3,
      components: [],
      layouts: ['x'],
      formats: ['bf16'],
      proposalHead: false,
    });
  });

  it('the container: the magic, the version either way round, a manifest length no header has', () => {
    expect(parseNinferContainer(head('NINFER', [0, 3], 340_000n))).toEqual({ containerVersion: 3, manifestBytes: 340_000 });
    expect(parseNinferContainer(head('NINFER', [3, 0], 10n))).toEqual({ containerVersion: 3, manifestBytes: 10 });
    expect(parseNinferContainer(head('GGUFxx', [0, 3], 10n))).toBeUndefined();
    expect(parseNinferContainer(head('NINFER', [0, 3], 2n))).toBeUndefined();
    expect(parseNinferContainer(head('NINFER', [0, 3], BigInt(NINFER_MANIFEST_MAX + 1)))).toBeUndefined();
    expect(parseNinferContainer(new Uint8Array(10))).toBeUndefined();
    expect(parseNinferEmbeddedManifest('text')).toBeUndefined();
    expect(parseNinferEmbeddedManifest({ objects: [], metadata: { name: '' } })).toEqual({ components: [], layouts: [], formats: [], proposalHead: false });
  });
});
