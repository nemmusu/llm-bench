/**
 * What LLM Bench added for a saved engine, removed from the same place as the engine: the checkout of a
 * NInfer variant it cloned and built (its record of the build is in the folder), the Docker image it
 * pulled for the engine when the image was not on this PC (CustomEngine.pulledImage). Everything else is
 * the user's own and is never deleted: a program or a folder they chose, an image they pulled or built,
 * the images of the built-in engines' own repositories (their cards manage them), and files another
 * saved engine still runs.
 */
import type { CustomEngine, CustomEngineFiles } from '../../../contract/custom-engines';
import { ninferServeOf } from '../../../contract/ninfer';

export interface CustomEngineFilesDeps {
  /** A NInfer variant's checkout, when LLM Bench built it in a folder it deletes (ninfer/setup.ts). */
  ninfer?: {
    files(engine: CustomEngine): Promise<CustomEngineFiles | undefined>;
    remove(engine: CustomEngine, files: CustomEngineFiles): Promise<void>;
  };
  /** Docker images (core/docker/images.ts). */
  images?: {
    inspect(ref: string): Promise<{ size: number } | undefined>;
    remove(ref: string): Promise<void>;
  };
  /** The built-in engines' image repositories ("vllm/vllm-openai"): never removed with a custom engine. */
  officialRepos: readonly string[];
}

/** "team/sglang:v1" → "team/sglang" (a digest or a tag after the last name). */
function repoOf(image: string): string {
  const name = image.split('@')[0] as string;
  const colon = name.lastIndexOf(':');
  return colon > name.lastIndexOf('/') ? name.slice(0, colon) : name;
}

/** The checkout another saved engine runs from (its folder and distro). */
function checkoutOf(e: CustomEngine): string | undefined {
  return e.run.mode === 'ninfer' ? `${e.run.distro ?? ''}|${ninferServeOf(e.run.path).repo ?? ''}` : undefined;
}

export function createCustomEngineFiles(d: CustomEngineFilesDeps) {
  return {
    async plan(engine: CustomEngine, all: readonly CustomEngine[]): Promise<CustomEngineFiles | undefined> {
      const others = all.filter((e) => e.id !== engine.id);
      if (engine.run.mode === 'ninfer') {
        const files = await d.ninfer?.files(engine);
        if (!files) return undefined;
        const mine = `${files.distro ?? ''}|${files.target}`;
        return others.some((e) => checkoutOf(e) === mine) ? undefined : files;
      }
      if (engine.run.mode !== 'docker' || engine.pulledImage !== engine.run.image) return undefined;
      const image = engine.run.image;
      if (d.officialRepos.includes(repoOf(image)) || others.some((e) => e.run.mode === 'docker' && e.run.image === image)) return undefined;
      // Already removed by hand: nothing left to remove.
      const info = await d.images?.inspect(image).catch(() => undefined);
      return info ? { kind: 'image', target: image, sizeBytes: info.size, command: `docker rmi ${image}` } : undefined;
    },
    async remove(engine: CustomEngine, files: CustomEngineFiles): Promise<void> {
      if (files.kind === 'image') await d.images?.remove(files.target);
      else await d.ninfer?.remove(engine, files);
    },
  };
}
