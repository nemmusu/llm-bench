import { describe, expect, it } from 'vitest';
import { missingLibrary, missingLibraryError } from '../../../../src/core/process/missing-library';

const out = (lib: string) => `./llama-server: error while loading shared libraries: ${lib}: cannot open shared object file: No such file or directory`;

describe('missing system libraries', () => {
  it('names the library and the Debian/Ubuntu package that ships it', () => {
    expect(missingLibrary(out('libgomp.so.1'))).toEqual({ library: 'libgomp.so.1', package: 'libgomp1' });
    expect(missingLibrary(out('libstdc++.so.6'))).toEqual({ library: 'libstdc++.so.6', package: 'libstdc++6' });
    expect(missingLibrary(out('libcurl.so.4.8.0'))).toEqual({ library: 'libcurl.so.4.8.0', package: 'libcurl4' });
    expect(missingLibrary(out('libfoo.so'))).toEqual({ library: 'libfoo.so', package: 'libfoo' });
    expect(missingLibrary('Segmentation fault')).toBeUndefined();
    expect(missingLibrary('')).toBeUndefined();
  });

  it('as an error with the params the message needs', () => {
    const e = missingLibraryError(`noise\n${out('libgomp.so.1')}\n`, '/x/llama-server');
    expect(e).toMatchObject({ code: 'ENGINE_MISSING_LIBRARY', params: { library: 'libgomp.so.1', package: 'libgomp1' } });
    expect(e?.message).toBe('/x/llama-server: the system library libgomp.so.1 is missing');
    expect(e?.detail).toContain('libgomp.so.1');
    expect(missingLibraryError('ok', 'x')).toBeUndefined();
  });
});
