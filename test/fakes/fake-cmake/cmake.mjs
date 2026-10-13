#!/usr/bin/env node
// A stand-in for `cmake --build <dir>` in E2E (GPUBENCH_CMAKE=["node", this file]): it "rebuilds" a
// fake llama.cpp fork by copying the source folder's VERSION into <dir>/bin/BUILD (the fork's wrapper
// reports it as its build number) and touching every file in <dir>/bin, printing Make-style progress.
// `cmake --version` answers like the real one.
import { readdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (argv[0] === '--version') {
  process.stdout.write('cmake version 3.31.0\n\nCMake suite maintained and supported by Kitware (kitware.com/cmake).\n');
  process.exit(0);
}
if (argv[0] !== '--build' || argv[1] === undefined) {
  process.stderr.write(`fake cmake: unsupported arguments ${argv.join(' ')}\n`);
  process.exit(1);
}

const buildDir = argv[1];
const cache = readFileSync(path.join(buildDir, 'CMakeCache.txt'), 'utf8');
const source = /^CMAKE_HOME_DIRECTORY:INTERNAL=(.+)$/m.exec(cache)?.[1]?.trim();
if (!source) {
  process.stderr.write('CMake Error: the cache names no source folder\n');
  process.exit(1);
}
const steps = ['Building CXX object common/CMakeFiles/common.dir/common.cpp.o', 'Building CXX object src/CMakeFiles/llama.dir/llama.cpp.o', 'Building CXX object tools/server/CMakeFiles/llama-server.dir/server.cpp.o', 'Linking CXX executable ../../bin/llama-server'];
for (let i = 0; i < steps.length; i++) {
  process.stdout.write(`[${String(Math.round(((i + 1) / steps.length) * 100)).padStart(3)}%] ${steps[i]}\n`);
  await sleep(150);
}
const bin = path.join(buildDir, 'bin');
writeFileSync(path.join(bin, 'BUILD'), readFileSync(path.join(source, 'VERSION'), 'utf8').trim());
const now = new Date();
for (const f of readdirSync(bin)) utimesSync(path.join(bin, f), now, now);
process.stdout.write('[100%] Built target llama-server\n');
