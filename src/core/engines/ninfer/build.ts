/**
 * Guided build of NInfer (no binary release: it runs from its build tree). On Linux, or inside a WSL
 * distro the user picked, and only after the user has seen the exact commands and confirmed them:
 *
 *   git clone https://github.com/Neroued/ninfer.git <dir>        (skipped when <dir> is a checkout)
 *   cmake -S <dir> -B <dir>/build -G Ninja -DCMAKE_BUILD_TYPE=Release [-DCMAKE_CUDA_COMPILER=…/nvcc]
 *   cmake --build <dir>/build -j
 *
 * Prerequisites are checked first (one read-only script); what is missing is listed with its apt
 * packages and a "sudo apt install …" line to copy: GPU Bench never installs system packages, and never
 * changes anything else in the distro. Progress comes from git's and ninja's own lines ("[12/345]").
 */
import { NINFER_REPO_URL, NINFER_SERVE_PATH, type NinferBuildPlan, type NinferBuildRequest, type NinferKind, type NinferPrereq } from '../../../contract/ninfer';
import { AppError } from '../../../contract/errors';
import type { ManagedProcess, ProcessRunner } from '../../deps';
import type { ProgressSink } from '../types';
import { distroRunner, OWNER_ENV, PID_SCRIPT, WSL_ENV, type DistroRun, type WslProcesses } from './wsl';
import { PID_LINE } from './logs';

/** One script: the version of every prerequisite, one "##id value" line each (empty = missing). */
export const PREREQ_SCRIPT = [
  'echo "##home $HOME"',
  'echo "##git $(git --version 2>/dev/null)"',
  'echo "##cmake $(cmake --version 2>/dev/null | head -n 1)"',
  'echo "##ninja $(ninja --version 2>/dev/null)"',
  'echo "##compiler $( (g++ --version || c++ --version) 2>/dev/null | head -n 1)"',
  'echo "##pkg-config $(pkg-config --version 2>/dev/null)"',
  'nvcc=$(command -v nvcc || ls /usr/local/cuda/bin/nvcc 2>/dev/null)',
  'echo "##nvcc $nvcc"',
  'echo "##cuda $([ -n "$nvcc" ] && "$nvcc" --version 2>/dev/null | tail -n 2 | head -n 1)"',
  'echo "##ffmpeg $(pkg-config --modversion libavformat libavcodec libavutil libswscale 2>/dev/null | tr \'\\n\' \' \')"',
  'echo "##curl $(pkg-config --modversion libcurl 2>/dev/null)"',
  'd="$1"; [ "${d#\\~}" != "$d" ] && d="$HOME${d#\\~}"',
  'echo "##checkout $( [ -f "$d/CMakeLists.txt" ] && [ -d "$d/.git" ] && echo yes)"',
].join('\n');

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

/** Minimum versions (README: CMake 3.28, libcurl 7.85, a CUDA toolkit with sm_120a = 12.8+, 13.1 validated; C++20 = g++ 11+). */
const NEED: Partial<Record<NinferPrereq['id'], string>> = { cmake: '3.28', curl: '7.85', cuda: '12.8', compiler: '11' };

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

export interface PrereqReport {
  home?: string;
  nvcc?: string;
  checkout: boolean;
  prereqs: NinferPrereq[];
}

/** The prerequisite script's output. */
export function parsePrereqs(stdout: string): PrereqReport {
  const values = new Map<string, string>();
  for (const line of stdout.split(/\r?\n/)) {
    const m = /^##([a-z-]+) ?(.*)$/.exec(line);
    if (m) values.set(m[1] as string, (m[2] as string).trim());
  }
  const ids: NinferPrereq['id'][] = ['git', 'cmake', 'ninja', 'compiler', 'pkg-config', 'cuda', 'ffmpeg', 'curl'];
  const prereqs = ids.map((id): NinferPrereq => {
    const text = values.get(id) ?? '';
    // nvcc: "Cuda compilation tools, release 13.1, V13.1.80"; ffmpeg: four versions, all needed.
    const version = id === 'cuda' ? /release (\d+\.\d+)/.exec(text)?.[1] : id === 'ffmpeg' ? (text.split(/\s+/).filter(Boolean).length >= 4 ? text.split(/\s+/)[0] : undefined) : text ? firstVersion(text) : undefined;
    const need = NEED[id];
    const found = version !== undefined && (need === undefined || versionAtLeast(version, need));
    return { id, found, ...(version !== undefined ? { version } : {}), ...(need !== undefined ? { need } : {}), packages: PREREQ_PACKAGES[id] };
  });
  const home = values.get('home');
  const nvcc = values.get('nvcc');
  return { ...(home ? { home } : {}), ...(nvcc ? { nvcc } : {}), checkout: values.get('checkout') === 'yes', prereqs };
}

/** Exact argv of the build steps; the folder must be absolute (a ~ is expanded with the user's home first). */
export function buildSteps(dir: string, o: { existing: boolean; nvcc?: string | undefined }): { stage: 'clone' | 'configure' | 'build'; argv: string[] }[] {
  const nvccOnPath = o.nvcc === undefined || !o.nvcc.startsWith('/usr/local/cuda/');
  return [
    ...(o.existing ? [] : [{ stage: 'clone' as const, argv: ['git', 'clone', '--progress', NINFER_REPO_URL, dir] }]),
    { stage: 'configure', argv: ['cmake', '-S', dir, '-B', `${dir}/build`, '-G', 'Ninja', '-DCMAKE_BUILD_TYPE=Release', ...(nvccOnPath ? [] : [`-DCMAKE_CUDA_COMPILER=${o.nvcc}`])] },
    { stage: 'build', argv: ['cmake', '--build', `${dir}/build`, '-j'] },
  ];
}

const quote = (a: string): string => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`);

/** Progress of a build line: ninja "[12/345] Building CUDA object …", git "Receiving objects:  45% (…)". */
export function buildProgress(line: string): { done: number; total: number } | undefined {
  const ninja = /^\[(\d+)\/(\d+)\]/.exec(line.trim());
  if (ninja) return { done: Number(ninja[1]), total: Number(ninja[2]) };
  const git = /Receiving objects:\s+(\d+)%/.exec(line);
  return git ? { done: Number(git[1]), total: 100 } : undefined;
}

export interface NinferBuilderOptions {
  kind: NinferKind;
  proc: ProcessRunner;
  /** ninfer-wsl: wsl.exe and our process records (a cancelled build is stopped inside the distro). */
  wsl?: { argv: readonly string[]; processes: WslProcesses };
  newMarker: () => string;
}

export class NinferBuilder {
  constructor(private readonly o: NinferBuilderOptions) {}

  private runner(distro: string | undefined): DistroRun {
    if (this.o.kind === 'ninfer-wsl') {
      if (!distro) throw new AppError('VALIDATION', 'Choose a WSL distro', { params: { reason: 'distro_missing' } });
      return distroRunner(this.o.proc, (this.o.wsl as NonNullable<NinferBuilderOptions['wsl']>).argv, distro);
    }
    return (cmd, args, opts) => this.o.proc.run(cmd, args, opts);
  }

  /** The commands and what is missing for them (nothing runs but the read-only checks). */
  async plan(req: NinferBuildRequest): Promise<NinferBuildPlan> {
    return (await this.inspect(req)).plan;
  }

  private async inspect(req: NinferBuildRequest): Promise<{ plan: NinferBuildPlan; steps: ReturnType<typeof buildSteps> }> {
    const run = this.runner(req.distro);
    const wanted = (req.dir ?? '~/ninfer').trim();
    const out = await run('/bin/sh', ['-c', PREREQ_SCRIPT, 'sh', wanted], { timeoutMs: 60_000 });
    const report = parsePrereqs(out.stdout);
    if (report.home === undefined) {
      throw new AppError('ENGINE_INSTALL_FAILED', 'The Linux environment did not answer', { params: { reason: 'ninfer_prereqs' }, detail: `${out.stdout}\n${out.stderr}`.slice(0, 2000) });
    }
    // "~" is the user's home in the Linux environment (the script expanded it the same way).
    const dir = wanted.replace(/^~(?=\/|$)/, report.home).replace(/\/+$/, '');
    if (!dir.startsWith('/')) throw new AppError('VALIDATION', 'The folder must be an absolute Linux path', { params: { reason: 'ninfer_dir', dir } });
    const missing = report.prereqs.filter((p) => !p.found);
    const apt = missing.filter((p) => p.id !== 'cuda').flatMap((p) => p.packages);
    const steps = buildSteps(dir, { existing: report.checkout, nvcc: report.nvcc });
    const plan: NinferBuildPlan = {
      kind: this.o.kind,
      ...(req.distro ? { distro: req.distro } : {}),
      dir,
      servePath: `${dir}/${NINFER_SERVE_PATH}`,
      existing: report.checkout,
      commands: steps.map((st) => st.argv.map(quote).join(' ')),
      prereqs: report.prereqs,
      ...(apt.length ? { aptCommand: `sudo apt install ${apt.join(' ')}` } : {}),
      cudaFromNvidia: missing.some((p) => p.id === 'cuda'),
      ready: missing.length === 0,
    };
    return { plan, steps };
  }

  /** Runs the confirmed plan's steps; progress per step (stage, done/total). Returns the ninfer-serve path. */
  async build(req: NinferBuildRequest, progress: ProgressSink, signal: AbortSignal): Promise<string> {
    const { plan, steps } = await this.inspect(req);
    if (!plan.ready) {
      throw new AppError('ENGINE_INSTALL_FAILED', 'Prerequisites are missing', { params: { reason: 'ninfer_prereqs', missing: plan.prereqs.filter((p) => !p.found).map((p) => p.id).join(',') } });
    }
    for (const st of steps) await this.step(st.stage, st.argv, req.distro, progress, signal);
    return plan.servePath;
  }

  private async step(stage: 'clone' | 'configure' | 'build', argv: string[], distro: string | undefined, progress: ProgressSink, signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw new AppError('CANCELLED', 'Build cancelled');
    progress({ stage, bytesDone: 0 });
    const marker = this.o.newMarker();
    const wsl = this.o.kind === 'ninfer-wsl' ? (this.o.wsl as NonNullable<NinferBuilderOptions['wsl']>) : undefined;
    // WSL: in its own session (setsid) so a cancel stops the whole compile (cmake, ninja, nvcc), and only it.
    const [cmd, ...args] = wsl
      ? ([...wsl.argv, '-d', distro as string, '--exec', '/usr/bin/env', `${OWNER_ENV}=${marker}`, 'setsid', '/bin/sh', '-c', PID_SCRIPT, 'sh', ...argv] as [string, ...string[]])
      : (argv as [string, ...string[]]);
    let mp: ManagedProcess;
    try {
      mp = this.o.proc.spawn({ cmd, args, env: wsl ? { ...WSL_ENV } : {}, owner: { runId: marker, marker } });
    } catch (e) {
      throw new AppError('ENGINE_INSTALL_FAILED', `Cannot start ${argv[0]}`, { params: { reason: 'ninfer_build', stage }, cause: e });
    }
    let pid: number | undefined;
    const tail: string[] = [];
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
        if (tail.length > 60) tail.shift();
        const p = buildProgress(line.text);
        if (p) progress({ stage, bytesDone: p.done, bytesTotal: p.total });
      }
      const exit = await mp.exited;
      if (signal.aborted) throw new AppError('CANCELLED', 'Build cancelled');
      if (exit.code !== 0) throw new AppError('ENGINE_INSTALL_FAILED', `NInfer ${stage} failed`, { params: { reason: 'ninfer_build', stage, code: String(exit.code ?? exit.signal) }, detail: tail.join('\n') });
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
  }
}
