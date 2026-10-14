/**
 * The manifest a .ninfer file carries at its start: "NINFER", the container version, the manifest's
 * length (u64 little-endian at byte 8), then the JSON manifest from byte 32 (contract/formats.ts). Only
 * those bytes are read (at most NINFER_MANIFEST_MAX), never the weights after them: a 27B artifact of
 * 23 GB has a manifest of about 340 KB. Its tensor layouts say which build of NInfer reads the file
 * (contract/ninfer.ts ninferBuildFor), its components and name what the VRAM estimate counts.
 */
import { open } from 'node:fs/promises';
import { NINFER_HEADER_BYTES, parseNinferContainer, parseNinferEmbeddedManifest, type NinferEmbeddedManifest } from '../../contract/formats';

export interface NinferHeader extends NinferEmbeddedManifest {
  containerVersion: number;
}

/** The header of a .ninfer file; undefined when the file is not one, is cut short, or its manifest is not JSON. */
export async function readNinferHeader(file: string): Promise<NinferHeader | undefined> {
  let fh;
  try {
    fh = await open(file, 'r');
  } catch {
    return undefined;
  }
  try {
    const head = new Uint8Array(NINFER_HEADER_BYTES);
    const got = await fh.read(head, 0, NINFER_HEADER_BYTES, 0);
    const container = parseNinferContainer(head.subarray(0, got.bytesRead));
    if (!container) return undefined;
    const json = new Uint8Array(container.manifestBytes);
    const read = await fh.read(json, 0, container.manifestBytes, NINFER_HEADER_BYTES);
    if (read.bytesRead < container.manifestBytes) return undefined;
    let raw: unknown;
    try {
      raw = JSON.parse(new TextDecoder().decode(json));
    } catch {
      return undefined;
    }
    const manifest = parseNinferEmbeddedManifest(raw);
    return manifest ? { containerVersion: container.containerVersion, ...manifest } : undefined;
  } finally {
    await fh.close();
  }
}
