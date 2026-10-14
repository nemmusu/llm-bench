/**
 * Guided build of NInfer (no binary release: it runs from its build tree), the official one, NInfer-all
 * or another variant (a fork of the user's: any repository with the same CMake build). On Linux, or
 * inside a WSL distro the user picked, and only after the user has seen the exact commands and
 * confirmed them:
 *
 *   git clone --progress [--branch <b>] <repo> <dir>              (skipped when <dir> is a checkout)
 *   rm -rf -- <dir>/build/CMakeCache.txt <dir>/build/CMakeFiles   (only when an earlier configure did not
 *                                                                  finish, or used another CUDA compiler)
 *   cmake -S <dir> -B <dir>/build -G Ninja -DCMAKE_BUILD_TYPE=Release -DCMAKE_CUDA_ARCHITECTURES=120a
 *         -DCMAKE_CUDA_COMPILER=<the newest nvcc new enough>
 *   cmake --build <dir>/build -j
 *   git -C <dir> rev-parse HEAD > <dir>/build/.llmbench-built-commit   (what the program was built from)
 *
 * The architecture is the RTX 5090's (sm_120a): the official build defaults to it, NInfer-all to sm_86.
 * CUDA: the official build needs 12.8; NInfer-all refuses less than 13.1 for sm_120a (older nvcc
 * releases miscompile its kernels), and a checkout's own CMakeLists.txt check wins. Every installed
 * toolkit is looked at (/usr/local/cuda-X.Y, not only the one /usr/local/cuda points to: under `wsl
 * --exec` nvcc is not on PATH either), and the newest one new enough is passed to CMake. When none is,
 * the toolkit apt offers (NVIDIA's repository, no newer than the driver runs) is named in the "sudo apt
 * install …" line to copy: LLM Bench never installs system packages, and never changes anything else in
 * the distro. A folder holding a checkout of another repository, or other files, is never built.
 * Progress comes from git's and ninja's own lines ("[12/345]"); a failed step says why in plain words
 * when its output is a known one (CUDA too old, a missing package, no network, a full disk, the
 * compile running out of memory, local changes), with its last lines; its whole output is kept in a
 * log file of LLM Bench's.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { NINFER_ALL_SOURCE, sameGitRepo, type GitSource } from '../../../contract/custom-engines';
import {
  NINFER_ALL_CUDA_MIN,
  NINFER_BUILT_COMMIT_FILE,
  NINFER_CUDA_MIN,
  NINFER_DEFAULT_DIR,
  NINFER_SERVE_PATH,
  NINFER_SOURCE,
  type NINFER_BUILD_STAGES,
  type NinferBuildPlan,
  type NinferBuildRequest,
  type NinferCuda,
  type NinferKind,
  type NinferPrereq,
} from '../../../contract/ninfer';
import { AppError, isAppError } from '../../../contract/errors';
import type { ManagedProcess, ProcessRunner } from '../../deps';
import type { ProgressSink } from '../types';
import { distroRunner, hostArgv, OWNER_ENV, PID_SCRIPT, WSL_ENV, type DistroRun, type WslProcesses } from './wsl';
import { PID_LINE } from './logs';

/** A step of a build or an update (engine.install stage). */
export type NinferBuildStage = (typeof NINFER_BUILD_STAGES)[number];

/** One script: the version of every prerequisite, one "##id value" line each (empty = missing). */
export const PREREQ_SCRIPT = [
  'echo "##home $HOME"',
  'echo "##git $(git --version 2>/dev/null)"',
  'echo "##cmake $(cmake --version 2>/dev/null | head -n 1)"',
  'echo "##ninja $(ninja --version 2>/dev/null)"',
  'echo "##compiler $( (g++ --version || c++ --version) 2>/dev/null | head -n 1)"',
  'echo "##pkg-config $(pkg-config --version 2>/dev/null)"',
  // Every CUDA compiler there (on PATH, /usr/local/cuda, each /usr/local/cuda-X.Y): its real path and release.
  String.raw`for n in $(command -v nvcc) /usr/local/cuda/bin/nvcc /usr/local/cuda-*/bin/nvcc; do [ -x "$n" ] && echo "##nvcc $(readlink -f "$n") $("$n" --version 2>/dev/null | grep -o 'release [0-9][0-9.]*' | head -n 1)"; done`,
  // The CUDA toolkits apt offers (read-only), and the newest CUDA the driver runs.
  String.raw`echo "##apt-cuda $(apt-cache search --names-only '^cuda-toolkit-[0-9]+-[0-9]+$' 2>/dev/null | cut -d ' ' -f 1 | tr '\n' ' ')"`,
  's=$(command -v nvidia-smi || ls /usr/lib/wsl/lib/nvidia-smi 2>/dev/null)',
  String.raw`echo "##driver-cuda $([ -n "$s" ] && "$s" 2>/dev/null | grep -o 'CUDA Version: [0-9.]*' | head -n 1)"`,
  String.raw`echo "##ffmpeg $(pkg-config --modversion libavformat libavcodec libavutil libswscale 2>/dev/null | tr '\n' ' ')"`,
  'echo "##curl $(pkg-config --modversion libcurl 2>/dev/null)"',
  'echo "##cpus $(nproc 2>/dev/null)"',
  'd="$1"; [ "${d#\\~}" != "$d" ] && d="$HOME${d#\\~}"',
  'echo "##checkout $( [ -f "$d/CMakeLists.txt" ] && [ -d "$d/.git" ] && echo yes)"',
  'echo "##origin $(git -C "$d" remote get-url origin 2>/dev/null)"',
  'echo "##exists $( [ -e "$d" ] && echo yes)"',
  'echo "##empty $( [ -d "$d" ] && [ -z "$(ls -A "$d" 2>/dev/null)" ] && echo yes)"',
  // The CUDA a sm_120a build of this checkout asks for: a "120a … VERSION_LESS x.y" check in its CMakeLists.txt.
  String.raw`echo "##cmake-cuda $(grep -o -E '120a.*VERSION_LESS[[:space:]]+"?[0-9]+\.[0-9]+' "$d/CMakeLists.txt" 2>/dev/null | grep -o -E '[0-9]+\.[0-9]+$' | sort -V | tail -n 1)"`,
  // What an earlier configure left in build/: its cache, the CUDA compiler it used, whether it finished.
  'echo "##cache $( [ -f "$d/build/CMakeCache.txt" ] && echo yes)"',
  String.raw`echo "##cache-nvcc $(sed -n 's/^CMAKE_CUDA_COMPILER:[A-Z]*=//p' "$d/build/CMakeCache.txt" 2>/dev/null | head -n 1)"`,
  'echo "##configured $( [ -f "$d/build/build.ninja" ] && echo yes)"',
].join('\n');

/** After a successful build: the commit the program was built from, next to it (the card's "Da ricompilare"). */
export const RECORD_SCRIPT = `git -C "$1" rev-parse HEAD > "$1/${NINFER_BUILT_COMMIT_FILE}" && echo "##gpubench-recorded"`;

/** apt packages per prerequisite (Ubuntu / Debian). CUDA: NVIDIA's repository (Ubuntu's own toolkit is too old for sm_120a). */
export const PREREQ_PACKAGES: Record<NinferPrereq['id'], string[]> = {
  git: ['git'],
  cmake: ['cmake'],
  ninja: ['ninja-build'],
  compiler: ['build-essential'],
  'pkg-config': ['pkg-config'],
  cuda: ['cuda-toolkit-13-1'],
  ffmpeg: ['libavformat-dev', 'libavcodec-dev', 'libavutil-dev', 'libswscale-dev'],
  curl: ['libcurl4-openssl-dev'],
};

/** Minimum versions (README: CMake 3.28, libcurl 7.85; C++20 = g++ 11+). CUDA's depends on the build (cudaNeed). */
const NEED: Partial<Record<NinferPrereq['id'], string>> = { cmake: '3.28', curl: '7.85', compiler: '11' };

/** "3.28.3" ≥ "3.28". */
export function versionAtLeast(have: string, need: string): boolean {
  const a = have.split('.').map(Number);
  const b = need.split('.').map(Number);
  for (let i = 0; i < b.length; i++) {
    const x = a[i] ?? 0;
    const y = b[i] as number;
    if (x !== y) return x > y;
  }
  return true;
}

const firstVersion = (text: string): string | undefined => /(\d+\.\d+(?:\.\d+)?)/.exec(text)?.[1];

/** An installed CUDA compiler: its real path and release ("13.0"). */
export interface InstalledNvcc {
  path: string;
  version: string;
}

export interface PrereqReport {
  home?: string;
  checkout: boolean;
  /** The checkout's origin URL, when the folder is one. */
  origin?: string;
  /** CPU cores (nproc). */
  cpus?: number;
  /** Everything but CUDA, which depends on the build (cudaChoice). */
  prereqs: NinferPrereq[];
  /** Every CUDA compiler installed. */
  nvccs: InstalledNvcc[];
  /** CUDA toolkits apt offers ("cuda-toolkit-13-3"). */
  aptCuda: string[];
  /** The newest CUDA the driver runs ("13.4"). */
  driverCuda?: string;
  /** The CUDA the checkout's CMakeLists.txt asks for a sm_120a build. */
  cmakeCuda?: string;
  /** The folder is there; it is an empty folder. */
  exists: boolean;
  empty: boolean;
  /** build/CMakeCache.txt is there, the CUDA compiler it names, and whether that configure finished (build.ninja). */
  cache: boolean;
  cacheNvcc?: string;
  configured: boolean;
}

const OTHER_IDS = ['git', 'cmake', 'ninja', 'compiler', 'pkg-config', 'ffmpeg', 'curl'] as const;

/** The prerequisite script's output. */
export function parsePrereqs(stdout: string): PrereqReport {
  const values = new Map<string, string>();
  const nvccs: InstalledNvcc[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const m = /^##([a-z-]+) ?(.*)$/.exec(line);
    if (!m) continue;
    const value = (m[2] as string).trim();
    if (m[1] === 'nvcc') {
      const n = /^(\S+) release (\d+\.\d+)/.exec(value);
      if (n && !nvccs.some((x) => x.path === n[1])) nvccs.push({ path: n[1] as string, version: n[2] as string });
    } else values.set(m[1] as string, value);
  }
  const prereqs = OTHER_IDS.map((id): NinferPrereq => {
    const text = values.get(id) ?? '';
    // ffmpeg: four versions, all needed.
    const version = id === 'ffmpeg' ? (text.split(/\s+/).filter(Boolean).length >= 4 ? text.split(/\s+/)[0] : undefined) : text ? firstVersion(text) : undefined;
    const need = NEED[id];
    const found = version !== undefined && (need === undefined || versionAtLeast(version, need));
    return { id, found, ...(version !== undefined ? { version } : {}), ...(need !== undefined ? { need } : {}), packages: PREREQ_PACKAGES[id] };
  });
  const opt = (key: string) => values.get(key) || undefined;
  const yes = (key: string) => values.get(key) === 'yes';
  const cpus = Number(values.get('cpus'));
  const home = opt('home');
  const origin = opt('origin');
  const driverCuda = /(\d+\.\d+)/.exec(values.get('driver-cuda') ?? '')?.[1];
  const cmakeCuda = opt('cmake-cuda');
  const cacheNvcc = opt('cache-nvcc');
  return {
    ...(home ? { home } : {}),
    checkout: yes('checkout'),
    ...(origin ? { origin } : {}),
    ...(Number.isInteger(cpus) && cpus > 0 ? { cpus } : {}),
    prereqs,
    nvccs,
    aptCuda: (values.get('apt-cuda') ?? '').split(/\s+/).filter((p) => /^cuda-toolkit-\d+-\d+$/.test(p)),
    ...(driverCuda ? { driverCuda } : {}),
    ...(cmakeCuda ? { cmakeCuda } : {}),
    exists: yes('exists'),
    empty: yes('empty'),
    cache: yes('cache'),
    ...(cacheNvcc ? { cacheNvcc } : {}),
    configured: yes('configured'),
  };
}

/** Newest first ("13.3" before "13.1"). */
const newestFirst = <T extends { version: string }>(list: readonly T[]): T[] => [...list].sort((a, b) => (versionAtLeast(a.version, b.version) ? -1 : 1));

/**
 * The CUDA of a build: its minimum (the official 12.8, NInfer-all's 13.1, a checkout's own check), the
 * newest compiler that meets it, and when none does the toolkit apt offers (the newest of the same major
 * release as the minimum the driver runs, else the oldest newer one).
 */
export function cudaChoice(r: Pick<PrereqReport, 'nvccs' | 'aptCuda' | 'driverCuda' | 'cmakeCuda'>, all: boolean): NinferCuda & { found: boolean } {
  const floors = [NINFER_CUDA_MIN, ...(all ? [NINFER_ALL_CUDA_MIN] : []), ...(r.cmakeCuda ? [r.cmakeCuda] : [])];
  const need = newestFirst(floors.map((version) => ({ version })))[0]?.version as string;
  const best = newestFirst(r.nvccs.filter((n) => versionAtLeast(n.version, need)))[0];
  const have = newestFirst(r.nvccs)[0]?.version;
  const offered = r.aptCuda
    .map((name) => ({ name, version: (/^cuda-toolkit-(\d+)-(\d+)$/.exec(name) as RegExpExecArray).slice(1, 3).join('.') }))
    .filter((p) => versionAtLeast(p.version, need) && (r.driverCuda === undefined || versionAtLeast(r.driverCuda, p.version)));
  const major = need.split('.')[0];
  const sameMajor = offered.filter((p) => p.version.split('.')[0] === major);
  const pick = sameMajor.length ? newestFirst(sameMajor)[0] : newestFirst(offered).at(-1);
  return {
    need,
    found: best !== undefined,
    ...(have ? { have } : {}),
    ...(best ? { nvcc: best.path } : pick ? { package: pick.name } : {}),
    ...(r.driverCuda ? { driver: r.driverCuda } : {}),
    ...(all && need !== NINFER_CUDA_MIN ? { allNeeds: true } : {}),
  };
}

/** "owner/repo" of a GitHub URL (its size can be asked); undefined for any other host. */
export function githubRepoOf(url: string): string | undefined {
  const m = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i.exec(url.trim());
  return m ? `${m[1]}/${m[2]}` : undefined;
}

/** Kept for the update and the tests: two URLs of the same repository. */
export const sameRepo = sameGitRepo;

/**
 * How long a compile takes, minutes (approximate). Measured: NInfer-all's 811 ninja steps took about
 * 25 minutes on 20 cores (Core Ultra 7 265F); a few CUDA objects (the attention kernels) take 3–5
 * minutes each on their own, so about 8 minutes do not shrink with more cores and the rest is about
 * 340 core-minutes. Unknown cores count as 8.
 */
export function buildMinutes(cpus: number | undefined): number {
  return Math.round(8 + 340 / (cpus ?? 8));
}

/**
 * Seconds a compile has left at the pace of its steps so far (`from`: the first step seen and when),
 * once it has run long enough to say (`afterMs`) and moved a few steps; undefined before. CUDA objects
 * are uneven (some take minutes): a rough figure, said as "circa".
 */
export function buildEtaSec(from: { at: number; step: number }, now: number, step: number, steps: number, afterMs = 20_000): number | undefined {
  const done = step - from.step;
  const elapsed = now - from.at;
  if (elapsed < afterMs || done < Math.max(3, steps * 0.02)) return undefined;
  return Math.round(((elapsed / done) * (steps - step)) / 1000);
}

/** Exact argv of the build steps; the folder must be absolute (a ~ is expanded with the user's home first). */
export function buildSteps(
  dir: string,
  o: { existing: boolean; nvcc?: string | undefined; source?: GitSource | undefined; clearCache?: boolean | undefined },
): { stage: NinferBuildStage; argv: string[] }[] {
  const source = o.source ?? NINFER_SOURCE;
  return [
    ...(o.existing ? [] : [{ stage: 'clone' as const, argv: ['git', 'clone', '--progress', ...(source.branch ? ['--branch', source.branch] : []), source.url, dir] }]),
    // Only the two things CMake keeps of a configure, only in this build folder.
    ...(o.clearCache ? [{ stage: 'configure' as const, argv: ['rm', '-rf', '--', `${dir}/build/CMakeCache.txt`, `${dir}/build/CMakeFiles`] }] : []),
    {
      stage: 'configure',
      argv: ['cmake', '-S', dir, '-B', `${dir}/build`, '-G', 'Ninja', '-DCMAKE_BUILD_TYPE=Release', '-DCMAKE_CUDA_ARCHITECTURES=120a', ...(o.nvcc ? [`-DCMAKE_CUDA_COMPILER=${o.nvcc}`] : [])],
    },
    { stage: 'build', argv: ['cmake', '--build', `${dir}/build`, '-j'] },
  ];
}

/** A word as a POSIX shell reads it back: bare when safe, else single-quoted. */
export const shellQuote = (a: string): string => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`);
/** An argv as one line to copy into a shell. */
export const shellLine = (argv: readonly string[]): string => argv.map(shellQuote).join(' ');

/** Progress of a build line: ninja "[12/345] Building CUDA object …", git "Receiving objects:  45% (…)". */
export function buildProgress(line: string): { done: number; total: number } | undefined {
  const ninja = /^\[(\d+)\/(\d+)\]/.exec(line.trim());
  if (ninja) return { done: Number(ninja[1]), total: Number(ninja[2]) };
  const git = /Receiving objects:\s+(\d+)%/.exec(line);
  return git ? { done: Number(git[1]), total: 100 } : undefined;
}

/** What a failed step's output says, in a few known shapes (ENGINE_INSTALL_FAILED / ENGINE_UPDATE_FAILED params.reading). */
export const BUILD_READINGS = ['cuda-too-old', 'out-of-memory', 'disk-full', 'no-network', 'local-changes', 'diverged', 'not-empty', 'cmake-too-old', 'missing-package'] as const;
export type BuildReading = (typeof BUILD_READINGS)[number];

const READINGS: { reading: BuildReading; re: RegExp; params?: (m: RegExpExecArray) => Record<string, string> }[] = [
  {
    // NInfer-all's CMakeLists.txt: "A 120a build needs CUDA 13.1 or newer; CUDA 13.0.88 miscompiles sm_120a kernels".
    reading: 'cuda-too-old',
    re: /needs CUDA (\d+\.\d+) or newer(?:; CUDA ([\d.]+) miscompiles)?|Unsupported gpu architecture '?compute_120a/i,
    params: (m) => ({ ...(m[1] ? { need: m[1] } : {}), ...(m[2] ? { have: m[2] } : {}) }),
  },
  { reading: 'out-of-memory', re: /Killed signal terminated program|internal compiler error: Killed|out of memory allocating|virtual memory exhausted|cc1plus: out of memory/i },
  { reading: 'disk-full', re: /No space left on device/i },
  { reading: 'no-network', re: /Could not resolve host|unable to access '?https?:|Failed to connect to|Connection timed out|Temporary failure in name resolution|Network is unreachable/i },
  { reading: 'local-changes', re: /would be overwritten by (?:merge|checkout)|Please commit your changes or stash them|You have unstaged changes/i },
  { reading: 'diverged', re: /Not possible to fast-forward|have diverged/i },
  { reading: 'not-empty', re: /already exists and is not an empty directory/i },
  { reading: 'cmake-too-old', re: /CMake ([\d.]+) or higher is required/i, params: (m) => ({ need: m[1] as string }) },
  {
    reading: 'missing-package',
    re: /Could NOT find (\w+)|Could not find (?:a package configuration file provided by )?"?(\w+)"?|No package '([^']+)' found|fatal error: ([\w/.+-]+\.h): No such file|No (CMAKE_CUDA_COMPILER|CMAKE_CXX_COMPILER) could be found/,
    params: (m) => ({ what: (m[1] ?? m[2] ?? m[3] ?? m[4] ?? m[5]) as string }),
  },
];

/** The plain-words reading of a failed step's output, when it is a known one. */
export function readBuildFailure(lines: readonly string[]): { reading: BuildReading; params: Record<string, string> } | undefined {
  const text = lines.join('\n');
  for (const r of READINGS) {
    const m = r.re.exec(text);
    if (m) return { reading: r.reading, params: r.params?.(m) ?? {} };
  }
  return undefined;
}

/** Lines of a failed step shown with its error (the whole output is in the log file). */
export const FAIL_TAIL = 20;

export interface NinferBuilderOptions {
  kind: NinferKind;
  proc: ProcessRunner;
  /** ninfer-wsl: wsl.exe and our process records (a cancelled build is stopped inside the distro). */
  wsl?: { argv: readonly string[]; processes: WslProcesses };
  newMarker: () => string;
  /** What cloning a GitHub repository downloads ("owner/repo" → bytes); undefined when it cannot be said. */
  repoBytes?: (repo: string) => Promise<number | undefined>;
  /** Where the whole output of a failed build or update is written (LLM Bench's own data folder). */
  logDir?: string;
  /** The most lines a log keeps (default LOG_LINES). */
  logLines?: number;
  /** How long a compile runs before its time left is said (default 20 s). */
  etaAfterMs?: number;
  /** Native, tests only: argv placed before every program (a fake Linux host through node). */
  launcherPrefix?: readonly string[];
}

/** The output of every step of one build or update, for its log file. */
export type BuildLog = string[];

/** The most lines a log keeps (the oldest go first). */
const LOG_LINES = 50_000;

export class NinferBuilder {
  private readonly prefix: readonly string[];

  constructor(private readonly o: NinferBuilderOptions) {
    this.prefix = o.launcherPrefix ?? [];
  }

  /** Runs a program where NInfer is built: the distro (WSL) or this system. */
  runner(distro: string | undefined): DistroRun {
    if (this.o.kind === 'ninfer-wsl') {
      if (!distro) throw new AppError('VALIDATION', 'Choose a WSL distro', { params: { reason: 'distro_missing' } });
      return distroRunner(this.o.proc, (this.o.wsl as NonNullable<NinferBuilderOptions['wsl']>).argv, distro);
    }
    return (cmd, args, opts) => this.o.proc.run(...hostArgv(this.prefix, [cmd, ...args]), opts);
  }

  /** The commands and what is missing for them (nothing runs but the read-only checks). */
  async plan(req: NinferBuildRequest): Promise<NinferBuildPlan> {
    return (await this.inspect(req)).plan;
  }

  private async inspect(req: NinferBuildRequest): Promise<{ plan: NinferBuildPlan; steps: ReturnType<typeof buildSteps> }> {
    const run = this.runner(req.distro);
    const wanted = (req.dir ?? NINFER_DEFAULT_DIR).trim();
    const out = await run('/bin/sh', ['-c', PREREQ_SCRIPT, 'sh', wanted], { timeoutMs: 90_000 });
    const report = parsePrereqs(out.stdout);
    if (report.home === undefined) {
      throw new AppError('ENGINE_INSTALL_FAILED', 'The Linux environment did not answer', { params: { reason: 'ninfer_prereqs' }, detail: `${out.stdout}\n${out.stderr}`.slice(0, 2000) });
    }
    // "~" is the user's home in the Linux environment (the script expanded it the same way).
    const dir = wanted.replace(/^~(?=\/|$)/, report.home).replace(/\/+$/, '');
    if (!dir.startsWith('/')) throw new AppError('VALIDATION', 'The folder must be an absolute Linux path', { params: { reason: 'ninfer_dir', dir } });
    // A variant without a repository of its own can only be built where its checkout already is.
    if (req.variant && !req.source && !report.checkout) {
      throw new AppError('VALIDATION', 'A variant without a repository is built in its own checkout only', { params: { reason: 'ninfer_no_source', dir } });
    }
    const source = req.source ?? NINFER_SOURCE;
    const all = req.build === 'all' || sameGitRepo(source.url, NINFER_ALL_SOURCE.url) || (report.origin !== undefined && sameGitRepo(report.origin, NINFER_ALL_SOURCE.url));
    const cuda = cudaChoice(report, all);
    const { found: cudaFound, ...cudaInfo } = cuda;
    const prereqs: NinferPrereq[] = [
      ...report.prereqs.slice(0, 5),
      { id: 'cuda', found: cudaFound, ...(cuda.have ? { version: cuda.have } : {}), need: cuda.need, packages: [cuda.package ?? `cuda-toolkit-${cuda.need.replace('.', '-')}`] },
      ...report.prereqs.slice(5),
    ];
    const missing = prereqs.filter((p) => !p.found);
    const apt = missing.flatMap((p) => (p.id === 'cuda' ? (cuda.package ? [cuda.package] : []) : p.packages));
    // A checkout of another repository than the one asked for (the official NInfer where NInfer-all was asked for):
    // never built as that one. Without a repository named (a checkout of the user's, built in place) it is taken as it is.
    const otherRepo = report.checkout && report.origin !== undefined && req.source !== undefined && !sameGitRepo(report.origin, req.source.url) ? report.origin : undefined;
    // Other files there and no checkout: git would refuse to clone into it.
    const notEmpty = !report.checkout && report.exists && !report.empty;
    // A configure that did not finish (NInfer-all's refusal of CUDA 13.0), or one made with another compiler: CMake keeps
    // the compiler and its version in its cache, so the new one is seen only after the cache is cleared.
    const clearCache = report.checkout && report.cache && (!report.configured || report.cacheNvcc !== cuda.nvcc);
    const steps = buildSteps(dir, { existing: report.checkout, nvcc: cuda.nvcc, source, clearCache });
    const github = report.checkout ? undefined : githubRepoOf(source.url);
    const downloadBytes = github && this.o.repoBytes ? await this.o.repoBytes(github).catch(() => undefined) : undefined;
    const plan: NinferBuildPlan = {
      kind: this.o.kind,
      ...(req.distro ? { distro: req.distro } : {}),
      dir,
      servePath: `${dir}/${NINFER_SERVE_PATH}`,
      existing: report.checkout,
      source,
      ...(otherRepo ? { otherRepo } : {}),
      commands: [...steps.map((st) => shellLine(st.argv)), `git -C ${shellQuote(dir)} rev-parse HEAD > ${shellQuote(`${dir}/${NINFER_BUILT_COMMIT_FILE}`)}`],
      prereqs,
      ...(apt.length ? { aptCommand: `sudo apt install ${apt.join(' ')}` } : {}),
      cudaFromNvidia: !cudaFound && cuda.package === undefined,
      cuda: cudaInfo,
      ...(clearCache ? { clearCache: true } : {}),
      ...(notEmpty ? { notEmpty: true } : {}),
      ...(downloadBytes !== undefined ? { downloadBytes } : {}),
      ...(report.cpus ? { cpus: report.cpus } : {}),
      minutes: buildMinutes(report.cpus),
      ready: missing.length === 0 && otherRepo === undefined && !notEmpty,
    };
    return { plan, steps };
  }

  /** Runs the confirmed plan's steps; progress per step (stage, done/total). Returns the ninfer-serve path. */
  async build(req: NinferBuildRequest, progress: ProgressSink, signal: AbortSignal): Promise<string> {
    const { plan, steps } = await this.inspect(req);
    if (plan.otherRepo) throw new AppError('ENGINE_INSTALL_FAILED', 'The folder holds another repository', { params: { reason: 'ninfer_other_repo', origin: plan.otherRepo, dir: plan.dir } });
    if (plan.notEmpty) throw new AppError('ENGINE_INSTALL_FAILED', 'The folder holds other files', { params: { reason: 'ninfer_dir_not_empty', dir: plan.dir } });
    if (!plan.ready) {
      throw new AppError('ENGINE_INSTALL_FAILED', 'Prerequisites are missing', {
        params: { reason: 'ninfer_prereqs', missing: plan.prereqs.filter((p) => !p.found).map((p) => p.id).join(','), ...(plan.cuda && !plan.cuda.nvcc ? { cudaNeed: plan.cuda.need } : {}) },
      });
    }
    const log: BuildLog = [];
    try {
      for (const st of steps) await this.step(st.stage, st.argv, req.distro, progress, signal, log);
    } catch (e) {
      throw await this.withLog(e, log, 'build');
    }
    await this.record(plan.dir, req.distro);
    return plan.servePath;
  }

  /** Writes down the commit the program was just built from (a failure only costs the "Da ricompilare" check). */
  async record(dir: string, distro: string | undefined): Promise<boolean> {
    const out = await this.runner(distro)('/bin/sh', ['-c', RECORD_SCRIPT, 'sh', dir], { timeoutMs: 60_000 }).catch(() => undefined);
    return out?.stdout.includes('##gpubench-recorded') === true;
  }

  /** The error of a failed build or update with the path of its whole output (a cancel is just a cancel). */
  async withLog(e: unknown, log: BuildLog, what: 'build' | 'update'): Promise<unknown> {
    if (!isAppError(e) || e.code === 'CANCELLED' || !this.o.logDir || log.length === 0) return e;
    const file = path.join(this.o.logDir, `ninfer-${what}-${new Date().toISOString().replace(/[:.]/g, '-')}.log`);
    const saved = await fs
      .mkdir(this.o.logDir, { recursive: true })
      .then(() => fs.writeFile(file, `${log.join('\n')}\n`))
      .then(
        () => true,
        () => false,
      );
    return saved ? new AppError(e.code, e.message, { params: { ...e.params, log: file }, detail: e.detail as string, cause: e }) : e;
  }

  /**
   * One step of a build or an update, as its own process (WSL: in its own session, marked as ours),
   * with progress from its lines; a cancel stops it (and only it). Throws ENGINE_INSTALL_FAILED with
   * the last lines and what they say (params.reading) when it fails, CANCELLED when cancelled. Every
   * line also goes to `log`. No time limit: a compile may take most of an hour.
   */
  async step(stage: NinferBuildStage, argv: string[], distro: string | undefined, progress: ProgressSink, signal: AbortSignal, log: BuildLog): Promise<void> {
    if (signal.aborted) throw new AppError('CANCELLED', 'Build cancelled');
    progress({ stage, bytesDone: 0 });
    const marker = this.o.newMarker();
    const wsl = this.o.kind === 'ninfer-wsl' ? (this.o.wsl as NonNullable<NinferBuilderOptions['wsl']>) : undefined;
    // git never asks for a password: with no terminal it would wait for ever.
    const quiet = { GIT_TERMINAL_PROMPT: '0' };
    // WSL: in its own session (setsid) so a cancel stops the whole compile (cmake, ninja, nvcc), and only it.
    // `-w`: under `wsl --exec` the command is already a group leader, so setsid forks; without waiting it
    // would answer 0 at once and the step would look done (and successful) while it is still running.
    const [cmd, ...args] = wsl
      ? ([...wsl.argv, '-d', distro as string, '--exec', '/usr/bin/env', `${OWNER_ENV}=${marker}`, 'GIT_TERMINAL_PROMPT=0', 'setsid', '-w', '/bin/sh', '-c', PID_SCRIPT, 'sh', ...argv] as [string, ...string[]])
      : ([...this.prefix, ...argv] as [string, ...string[]]);
    log.push(`$ ${shellLine(argv)}`);
    let mp: ManagedProcess;
    try {
      mp = this.o.proc.spawn({ cmd, args, env: wsl ? { ...WSL_ENV } : quiet, owner: { runId: marker, marker } });
    } catch (e) {
      throw new AppError('ENGINE_INSTALL_FAILED', `Cannot start ${argv[0]}`, { params: { reason: 'ninfer_build', stage }, cause: e });
    }
    let pid: number | undefined;
    const tail: string[] = [];
    let pace: { at: number; step: number } | undefined;
    const onAbort = () => {
      void (async () => {
        if (wsl && pid !== undefined) await wsl.processes.stop({ distro: distro as string, pid, marker }, mp.exited, { group: true }).catch(() => false);
        await mp.stop();
      })();
    };
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      for await (const line of mp.lines) {
        const own = PID_LINE.exec(line.text)?.[1];
        if (own !== undefined && pid === undefined) {
          pid = Number(own);
          continue;
        }
        tail.push(line.text);
        if (tail.length > 200) tail.shift();
        log.push(line.text);
        if (log.length > (this.o.logLines ?? LOG_LINES)) log.shift();
        const p = buildProgress(line.text);
        if (!p) continue;
        // A compile's time left, from the pace of its own steps ("[412/811]").
        const now = Date.now();
        pace ??= { at: now, step: p.done };
        const eta = stage === 'build' ? buildEtaSec(pace, now, p.done, p.total, this.o.etaAfterMs) : undefined;
        progress({ stage, bytesDone: p.done, bytesTotal: p.total, etaSec: eta });
      }
      const exit = await mp.exited;
      if (signal.aborted) throw new AppError('CANCELLED', 'Build cancelled');
      if (exit.code !== 0) {
        // The reading looks at more than the lines shown (CMake prints its error well before its last lines).
        const reading = readBuildFailure(tail);
        throw new AppError('ENGINE_INSTALL_FAILED', `NInfer ${stage} failed`, {
          params: { reason: 'ninfer_build', stage, code: String(exit.code ?? exit.signal), ...(reading ? { reading: reading.reading, ...reading.params } : {}) },
          detail: tail.slice(-FAIL_TAIL).join('\n'),
        });
      }
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
  }
}
