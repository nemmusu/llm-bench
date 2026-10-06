import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { AppError } from '../../contract/errors';
import { REPO_RE } from './paths';

/** VRAM tiers (GB) of resources/curated-models.json; an entry is recommended from its tier up. */
export const CURATED_TIERS = [8, 12, 16, 24, 32, 48, 80] as const;

const sha = z.string().regex(/^[0-9a-f]{64}$/);
const commit = z.string().regex(/^[0-9a-f]{40}$/);
const repo = z.string().regex(REPO_RE);

export const curatedModelSchema = z
  .object({
    id: z.string().min(1),
    label: z.string().min(1),
    /** llamacpp → a GGUF `file`; vllm → the whole safetensors repo. */
    engine: z.enum(['llamacpp', 'vllm']),
    tier: z
      .number()
      .int()
      .refine((t) => (CURATED_TIERS as readonly number[]).includes(t), 'Unknown VRAM tier'),
    repo,
    file: z.string().min(1).optional(),
    revision: commit,
    /** GGUF file bytes, or safetensors bytes of the repo for vLLM. */
    sizeBytes: z.number().int().positive(),
    sha256: sha.optional(),
    quant: z.string().min(1),
    paramsB: z.number().positive(),
    license: z.string().min(1),
    reference: z.boolean().optional(),
  })
  .refine((m) => (m.engine === 'llamacpp') === (m.file !== undefined), { message: 'llamacpp entries need a file, vllm entries must not have one' });
export type CuratedModel = z.infer<typeof curatedModelSchema>;

export const curatedListSchema = z.object({
  version: z.literal(1),
  verifiedAt: z.string(),
  /** Pinned model of the "standard score": fits in 8 GB, fixed revision and sha256. */
  reference: z.object({
    id: z.string(),
    label: z.string(),
    engine: z.literal('llamacpp'),
    repo,
    file: z.string().min(1),
    revision: commit,
    sizeBytes: z.number().int().positive(),
    sha256: sha,
    quant: z.string(),
    paramsB: z.number().positive(),
    license: z.string(),
  }),
  models: z.array(curatedModelSchema).min(1),
});
export type CuratedList = z.infer<typeof curatedListSchema>;

export const CURATED_FILE = 'curated-models.json';

/** Loads and validates the bundled list; a broken file is a packaging bug (INTERNAL). */
export async function loadCurated(resourcesDir: string): Promise<CuratedList> {
  const file = path.join(resourcesDir, CURATED_FILE);
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(file, 'utf8'));
  } catch (e) {
    throw new AppError('INTERNAL', `Cannot read ${CURATED_FILE}`, { cause: e });
  }
  const parsed = curatedListSchema.safeParse(raw);
  if (!parsed.success) throw new AppError('INTERNAL', `Invalid ${CURATED_FILE}`, { detail: z.prettifyError(parsed.error) });
  return parsed.data;
}

/**
 * Entries recommended for a GPU with `vramGB`: every tier up to it, closest tier first (the
 * biggest models that still fit), then larger files first. `engine` narrows to one engine.
 */
export function curatedForVram(list: CuratedList, vramGB: number, engine?: CuratedModel['engine']): CuratedModel[] {
  return list.models
    .filter((m) => m.tier <= vramGB && (!engine || m.engine === engine))
    .sort((a, b) => b.tier - a.tier || b.sizeBytes - a.sizeBytes);
}
