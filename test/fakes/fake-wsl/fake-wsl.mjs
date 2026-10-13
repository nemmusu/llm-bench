#!/usr/bin/env node
// Fake `wsl.exe` for tests: the subset LLM Bench's NInfer support calls, with a pretend distro whose
// ninfer-serve is the fake engine (../fake-engine/ninfer-cli.mjs) running as a real child process.
//
//   -l -v                                        distros (UTF-16LE like the real one, UTF-8 with WSL_UTF8=1)
//   -d <distro> --exec /bin/sh -c <script> sh …  LLM Bench's probe (##gpubench-help), prerequisite check (##home),
//                                                update check (##nocheckout), keep / drop / restore of the build
//   -d <distro> --exec /usr/bin/env VAR=v… [setsid] /bin/sh -c '<pid script>' sh <program> <args…>
//                                                ninfer-serve (the fake), git clone / pull, cmake configure / build
//   -d <distro> --exec cat /proc/<pid>/environ   the environment of a process it started (NUL separated)
//   -d <distro> --exec kill -TERM|-KILL [--] [-]<pid>
//   -d <distro> --exec dd … | stat -c %s F | fincore …   cold-load eviction
//
// Environment:
//   FAKE_WSL_STATE   state dir (config.json with what the guided build added, procs.json); default <tmp>/gpubench-fake-wsl
//   FAKE_WSL_CONFIG  inline JSON or a file, merged over the defaults: { noWsl, distros: [{ name, default, version, state }],
//                    home, builds: [ninfer-serve paths], checkouts: [dirs], prereqs: { git: "git version 2.43.0", … ("" = missing) },
//                    commit, stepMs, failStage: 'clone' | 'configure' | 'pull' | 'build',
//                    branch ("master", "HEAD" = detached), upstream ("origin/master", null = none),
//                    incoming: [{ sha, title }] (to pull, newest first), ahead, dirty: [tracked files changed],
//                    offline (the fetch fails), tools: [upgrade tools in the checkout]; prereqs.git / .cmake "" = missing }
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const env = process.env;
const STATE = env.FAKE_WSL_STATE ?? path.join(os.tmpdir(), 'gpubench-fake-wsl');
const NINFER = fileURLToPath(new URL('../fake-engine/ninfer-cli.mjs', import.meta.url));
const argv = process.argv.slice(2);

const DEFAULTS = {
  noWsl: false,
  distros: [
    { name: 'Ubuntu-24.04', default: true, version: 2, state: 'Running' },
    { name: 'docker-desktop', default: false, version: 2, state: 'Stopped' },
  ],
  home: '/home/user',
  builds: ['/home/user/ninfer/build/apps/ninfer-serve'],
  checkouts: ['/home/user/ninfer'],
  prereqs: {
    git: 'git version 2.43.0',
    cmake: 'cmake version 3.28.3',
    ninja: '1.11.1',
    compiler: 'g++ (Ubuntu 13.3.0-6ubuntu2~24.04) 13.3.0',
    'pkg-config': '1.8.1',
    nvcc: '/usr/local/cuda/bin/nvcc',
    cuda: 'Cuda compilation tools, release 13.1, V13.1.80',
    ffmpeg: '60.16.100 60.31.102 58.29.100 7.5.100 ',
    curl: '8.5.0',
  },
  commit: 'e31bc99b13f517c8aae70b997b7c4a49b4dcdc5d',
  stepMs: 30,
  branch: 'master',
  upstream: 'origin/master',
  incoming: [],
  ahead: 0,
  dirty: [],
  offline: false,
  tools: ['tools/upgrade_ninfer_v2_to_v3.py'],
  kept: [],
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = (s) => process.stdout.write(s);
const err = (s) => process.stderr.write(s);

function readJson(file, fallback) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function config() {
  const raw = env.FAKE_WSL_CONFIG;
  const given = raw ? (raw.trim().startsWith('{') ? JSON.parse(raw) : readJson(raw, {})) : {};
  const saved = readJson(path.join(STATE, 'config.json'), {});
  return { ...DEFAULTS, ...given, ...saved, prereqs: { ...DEFAULTS.prereqs, ...given.prereqs } };
}

function save(patch) {
  mkdirSync(STATE, { recursive: true });
  const file = path.join(STATE, 'config.json');
  writeFileSync(file, JSON.stringify({ ...readJson(file, {}), ...patch }, null, 2));
}

const procsFile = () => path.join(STATE, 'procs.json');
function procs() {
  return readJson(procsFile(), {});
}
function setProc(pid, rec) {
  mkdirSync(STATE, { recursive: true });
  const all = procs();
  if (rec) all[pid] = rec;
  else delete all[pid];
  writeFileSync(procsFile(), JSON.stringify(all, null, 2));
}
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

function list(cfg) {
  if (cfg.noWsl) {
    err('Windows Subsystem for Linux has no installed distributions.\n');
    return 1;
  }
  const lines = ['  NAME              STATE           VERSION', ...cfg.distros.map((d) => `${d.default ? '*' : ' '} ${d.name.padEnd(17)} ${d.state.padEnd(15)} ${d.version}`)];
  const text = `${lines.join('\r\n')}\r\n`;
  process.stdout.write(env.WSL_UTF8 === '1' ? Buffer.from(text, 'utf8') : Buffer.from(`﻿${text}`, 'utf16le'));
  return 0;
}

/** LLM Bench's probe: the help (exit code after it) and the checkout's commit. */
function probe(cfg, serve, repo) {
  if (cfg.builds.includes(serve)) {
    out(readFileSync(new URL('../../fixtures/ninfer/help.stdout.txt', import.meta.url), 'utf8'));
    out('##gpubench-help 0\n');
  } else {
    out(`sh: 2: ${serve}: not found\n##gpubench-help 127\n`);
  }
  if (repo) out(`##gpubench-commit ${cfg.checkouts.includes(repo) ? cfg.commit : ''}\n`);
  return 0;
}

/** The prerequisite script: one "##id value" line each. */
function prereqs(cfg, dir) {
  const d = dir.startsWith('~') ? `${cfg.home}${dir.slice(1)}` : dir;
  const p = cfg.prereqs;
  const lines = [`##home ${cfg.home}`, ...['git', 'cmake', 'ninja', 'compiler', 'pkg-config', 'nvcc', 'cuda', 'ffmpeg', 'curl'].map((k) => `##${k} ${p[k] ?? ''}`), `##checkout ${cfg.checkouts.includes(d) ? 'yes' : ''}`];
  out(`${lines.join('\n')}\n`);
  return 0;
}

/** The checkout a folder is in (the folder itself or one below it), as `git rev-parse --show-toplevel`. */
function checkoutOf(cfg, start) {
  const d = start.startsWith('~') ? `${cfg.home}${start.slice(1)}` : start;
  return cfg.checkouts.find((c) => d === c || d.startsWith(`${c}/`));
}

/** LLM Bench's update check: "##key value" lines, as the real script prints them (`fetch` "1": git fetch first). */
function updateCheck(cfg, start, fetch) {
  if (cfg.prereqs.git === '') {
    out('##nogit\n');
    return 0;
  }
  const dir = checkoutOf(cfg, start);
  if (!dir) {
    out('##nocheckout\n');
    return 0;
  }
  const lines = [`##dir ${dir}`];
  if (fetch === '1') lines.push(...(cfg.offline ? ['##fetched no', '##fetcherr fatal: unable to access https://github.com/Neroued/ninfer.git/'] : ['##fetched yes']));
  lines.push(`##head ${cfg.commit}`, `##branch ${cfg.branch}`, `##upstream ${cfg.upstream ?? ''}`);
  if (cfg.upstream) lines.push(`##latest ${cfg.incoming[0]?.sha ?? cfg.commit}`, `##counts ${cfg.ahead}\t${cfg.incoming.length}`);
  for (const c of cfg.upstream ? cfg.incoming : []) lines.push(`##commit ${c.sha} ${c.title}`);
  for (const f of cfg.dirty) lines.push(`##dirty  M ${f}`);
  for (const t of cfg.tools) lines.push(`##tool ${t}`);
  lines.push(`##cmake ${cfg.prereqs.cmake === '' ? '' : '/usr/bin/cmake'}`);
  out(`${lines.join('\n')}\n`);
  return 0;
}

/** cp -p <serve> <serve>.gpubench-previous; rm -f of it; mv back + git reset --hard <commit>. */
function keep(cfg, script, args) {
  const serve = args[3] ?? '';
  if (script.includes('##gpubench-kept')) {
    if (!cfg.builds.includes(serve)) {
      err(`cp: cannot stat '${serve}': No such file or directory\n`);
      return 1;
    }
    save({ kept: [...new Set([...cfg.kept, serve])] });
    out('##gpubench-kept\n');
    return 0;
  }
  if (script.includes('##gpubench-dropped')) {
    save({ kept: cfg.kept.filter((k) => k !== serve) });
    out('##gpubench-dropped\n');
    return 0;
  }
  // Restore: the program kept aside back, the checkout back on the commit it was on.
  if (!cfg.kept.includes(serve)) {
    err(`mv: cannot stat '${serve}.gpubench-previous': No such file or directory\n`);
    return 1;
  }
  save({ kept: cfg.kept.filter((k) => k !== serve), commit: args[5], incoming: cfg.pulled?.incoming ?? cfg.incoming, pulled: null });
  out('##gpubench-restored\n');
  return 0;
}

/** A program started through the PID script: its PID first (stderr), then the program itself. */
async function launched(cfg, distro, vars, program, args) {
  if (program.endsWith('ninfer-serve')) {
    if (!cfg.builds.includes(program)) {
      err(`sh: 1: exec: ${program}: not found\n`);
      return 127;
    }
    const child = spawn(process.execPath, [NINFER, ...args], { env: { ...env, ...vars }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    err(`gpubench-pid ${child.pid}\n`);
    setProc(child.pid, { distro, env: Object.entries(vars).map(([k, v]) => `${k}=${v}`) });
    child.stdout.pipe(process.stdout);
    child.stderr.pipe(process.stderr);
    const code = await new Promise((r) => child.on('exit', (c) => r(c ?? 1)));
    setProc(child.pid, undefined);
    return code;
  }
  // Build steps run in this process: its PID is the one LLM Bench may stop.
  err(`gpubench-pid ${process.pid}\n`);
  setProc(process.pid, { distro, env: Object.entries(vars).map(([k, v]) => `${k}=${v}`) });
  try {
    const step = cfg.stepMs ?? 30;
    if (program === 'git' && args[0] === 'clone') {
      const dir = args[args.length - 1];
      err(`Cloning into '${dir}'...\n`);
      for (const pct of [25, 50, 100]) {
        await sleep(step);
        err(`Receiving objects: ${String(pct).padStart(3)}% (${pct * 12}/1200)\r`);
      }
      err('\n');
      if (cfg.failStage === 'clone') {
        err('fatal: unable to access the repository\n');
        return 128;
      }
      save({ checkouts: [...new Set([...config().checkouts, dir])] });
      return 0;
    }
    if (program === 'git' && args[2] === 'pull') {
      await sleep(step);
      if (cfg.failStage === 'pull' || cfg.dirty.length || cfg.ahead) {
        err('fatal: Not possible to fast-forward, aborting.\n');
        return 128;
      }
      const to = cfg.incoming[0]?.sha ?? cfg.commit;
      out(`Updating ${cfg.commit.slice(0, 7)}..${to.slice(0, 7)}\nFast-forward\n`);
      save({ commit: to, incoming: [], pulled: { commit: cfg.commit, incoming: cfg.incoming } });
      return 0;
    }
    if (program === 'cmake' && args[0] === '-S') {
      await sleep(step);
      out('-- The CXX compiler identification is GNU 13.3.0\n-- The CUDA compiler identification is NVIDIA 13.1.80\n');
      if (cfg.failStage === 'configure') {
        err('CMake Error: Could not find FFmpeg (missing: libavformat)\n');
        return 1;
      }
      out(`-- Build files have been written to: ${args[3]}\n`);
      return 0;
    }
    if (program === 'cmake' && args[0] === '--build') {
      const total = 4;
      for (let i = 1; i <= total; i++) {
        await sleep(step);
        out(`[${i}/${total}] ${i === total ? 'Linking CXX executable apps/ninfer-serve' : `Building CUDA object src/ops/kernel_${i}.cu.o`}\n`);
        if (cfg.failStage === 'build' && i === 2) {
          err('nvcc fatal: Unsupported gpu architecture compute_120a\n');
          return 1;
        }
      }
      save({ builds: [...new Set([...config().builds, `${args[1]}/apps/ninfer-serve`])] });
      return 0;
    }
    err(`sh: 1: exec: ${program}: not found\n`);
    return 127;
  } finally {
    setProc(process.pid, undefined);
  }
}

async function exec(cfg, distro, cmd, args) {
  if (cmd === '/bin/sh' && args[0] === '-c') {
    const script = args[1] ?? '';
    if (script.includes('##gpubench-help')) return probe(cfg, args[3] ?? '', args[4] ?? '');
    if (script.includes('##home')) return prereqs(cfg, args[3] ?? '~/ninfer');
    if (script.includes('##nocheckout')) return updateCheck(cfg, args[3] ?? '', args[4]);
    if (script.includes('##gpubench-kept') || script.includes('##gpubench-dropped') || script.includes('##gpubench-restored')) return keep(cfg, script, args);
    err('sh: unsupported script\n');
    return 2;
  }
  if (cmd === '/usr/bin/env') {
    const vars = {};
    let i = 0;
    for (; i < args.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(args[i]); i++) {
      const eq = args[i].indexOf('=');
      vars[args[i].slice(0, eq)] = args[i].slice(eq + 1);
    }
    let rest = args.slice(i);
    if (rest[0] === 'setsid') {
      // As the real one under `wsl --exec` (already a group leader): without -w it forks and answers 0 at once.
      if (rest[1] !== '-w') return 0;
      rest = rest.slice(2);
    }
    // /bin/sh -c '<pid script>' sh <program> <args…>
    if (rest[0] !== '/bin/sh' || rest[1] !== '-c' || !String(rest[2]).includes('gpubench-pid')) {
      err('env: unsupported command\n');
      return 2;
    }
    return launched(cfg, distro, vars, rest[4], rest.slice(5));
  }
  if (cmd === 'cat') {
    const pid = Number(/^\/proc\/(\d+)\/environ$/.exec(args[0] ?? '')?.[1]);
    const rec = procs()[pid];
    if (!rec || rec.distro !== distro || !alive(pid)) {
      err(`cat: ${args[0]}: No such file or directory\n`);
      return 1;
    }
    out(`PATH=/usr/bin\0${rec.env.join('\0')}\0`);
    return 0;
  }
  if (cmd === 'kill') {
    const target = args.filter((a) => a !== '--' && !/^-(TERM|KILL)$/.test(a))[0] ?? '';
    const pid = Math.abs(Number(target));
    if (!procs()[pid] || !alive(pid)) {
      err(`kill: (${pid}) - No such process\n`);
      return 1;
    }
    process.kill(pid);
    return 0;
  }
  if (cmd === 'dd') return 0;
  if (cmd === 'stat') {
    out('1000\n');
    return 0;
  }
  if (cmd === 'fincore') {
    out('0\n');
    return 0;
  }
  err(`${cmd}: not found\n`);
  return 127;
}

async function main() {
  const cfg = config();
  if (argv[0] === '-l' || argv[0] === '--list') return list(cfg);
  const d = argv.indexOf('-d') >= 0 ? argv.indexOf('-d') : argv.indexOf('--distribution');
  const e = argv.findIndex((a) => a === '--exec' || a === '-e');
  if (d < 0 || e < 0) {
    err('Usage: wsl.exe [Argument] [Options...] [CommandLine]\n');
    return 1;
  }
  if (cfg.noWsl) {
    err('Windows Subsystem for Linux has no installed distributions.\n');
    return 1;
  }
  const distro = argv[d + 1];
  if (!cfg.distros.some((x) => x.name.toLowerCase() === String(distro).toLowerCase())) {
    err('There is no distribution with the supplied name.\r\nError code: Wsl/Service/WSL_E_DISTRO_NOT_FOUND\r\n');
    return 1;
  }
  return exec(cfg, distro, argv[e + 1], argv.slice(e + 2));
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (e) => {
    err(`fake-wsl: ${e?.stack ?? e}\n`);
    process.exit(70);
  },
);
