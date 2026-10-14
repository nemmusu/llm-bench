import { describe, expect, it } from 'vitest';
import type { LocalImage } from '../../../../src/contract/docker';
import { localImageFor, removalRef } from '../../../../src/renderer/lib/queries-images';

const image = (over: Partial<LocalImage>): LocalImage => ({ id: 'sha256:id', tags: [], digests: [], sizeBytes: 1, running: false, ...over });

describe('which Docker Hub tag a local image is', () => {
  it('by tag first, then by any digest the tag is known by (its index or a platform), as a digest or as the id', () => {
    const tagged = image({ id: 'sha256:a', tags: ['v1'] });
    const byPlatform = image({ id: 'sha256:b', digests: ['sha256:amd'] });
    const byIndex = image({ id: 'sha256:idx' });
    expect(localImageFor({ name: 'v1' }, [byPlatform, tagged])).toBe(tagged);
    expect(localImageFor({ name: 'v2', digests: ['sha256:idx2', 'sha256:amd'] }, [tagged, byPlatform])).toBe(byPlatform);
    expect(localImageFor({ name: 'v3', digest: 'sha256:idx' }, [tagged, byIndex])).toBe(byIndex);
    // Nothing to match by, or nothing on the PC.
    expect(localImageFor({ name: 'v4' }, [byPlatform])).toBeUndefined();
    expect(localImageFor({ name: 'v1' }, [])).toBeUndefined();
    expect(localImageFor({ name: 'v1' }, undefined)).toBeUndefined();
  });

  it('removed by its tag when it has it (its other tags stay), else by its id', () => {
    expect(removalRef('vllm/vllm-openai', 'v1', image({ tags: ['v1', 'latest'] }))).toBe('vllm/vllm-openai:v1');
    expect(removalRef('vllm/vllm-openai', 'v1', image({ id: 'sha256:x' }))).toBe('sha256:x');
  });
});
