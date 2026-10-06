import { AppError } from '../../contract/errors';

export interface MissingLibrary {
  /** e.g. "libgomp.so.1" */
  library: string;
  /** Debian/Ubuntu package that ships it, e.g. "libgomp1" (apt picks the t64 variant on 24.04). */
  package: string;
}

/**
 * The shared library the Linux loader could not find, from a program's output ("error while loading
 * shared libraries: libgomp.so.1: cannot open shared object file"). A minimal distro can lack
 * libraries prebuilt engines link against: the user needs the name and the one command that fixes it.
 */
export function missingLibrary(output: string): MissingLibrary | undefined {
  const library = /error while loading shared libraries: ([^:\s]+): cannot open shared object file/.exec(output)?.[1];
  if (!library) return undefined;
  // Debian names runtime packages after the soname: libgomp.so.1 → libgomp1, libstdc++.so.6 → libstdc++6.
  return { library, package: library.replace(/\.so(?:\.(\d+))?(?:\.\d+)*$/, '$1') };
}

/** ENGINE_MISSING_LIBRARY for that output, or undefined when no library is missing. */
export function missingLibraryError(output: string, what: string): AppError | undefined {
  const lib = missingLibrary(output);
  if (!lib) return undefined;
  return new AppError('ENGINE_MISSING_LIBRARY', `${what}: the system library ${lib.library} is missing`, {
    params: { library: lib.library, package: lib.package },
    detail: output.trim().slice(0, 2000),
  });
}
