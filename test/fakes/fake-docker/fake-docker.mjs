#!/usr/bin/env node
// Fake `docker` CLI for tests: the subset LLM Bench calls, with real child processes as
// "containers" (the fake engine bound to the published host port). Run with plain `node`.
//
//   version --format json | desktop start [--detach] | run [-d] [--rm] [--name N] [--label L]…
//   [--gpus G] [--ipc=host] [-p [ip:]host:cont] [-v src:dst[:ro]] [-e NAME[=V]] [--entrypoint E]
//   [--pull P] IMAGE [ARGS…] | logs [-f] [--timestamps] ID | stop [-t N] ID | rm [-f] ID… |
//   ps [-a] [--no-trunc] [--filter label=K[=V]]… [--format F] | container inspect ID | inspect ID |
//   image inspect REF | pull REF |
//   volume create [--label K=V]… NAME | volume inspect NAME… | volume ls [--filter label=K[=V]]… [--format {{.Name}}|-q] |
//   volume rm [-f] NAME…
//   internal: __container ID (the "container runtime"), __api --socket PATH (fake Engine API)
//
// Named volumes are folders under <state>/volumes/<name> (a `run -v name:/dst` creates one, like the
// daemon). The busybox helper image (present like every image not in FAKE_DOCKER_MISSING) runs
// `cp SRC… DST` and `du -sb DIR…` for real on the mounted folders, so model copies into volumes work.
//
// Environment:
//   FAKE_DOCKER_STATE     state dir (containers.json, logs/, daemon.json…); default <tmp>/gpubench-fake-docker
//   FAKE_DOCKER_MODE      running (default) | daemon-down | no-desktop-plugin | starting | permission-denied |
//                         no-gpu | podman | windows-containers | wsl-shim | old-driver |
//                         stuck (engine stuck stopping: version and reads answer from Docker Desktop's cache,
//                         `desktop status` says stopping, everything else fails with "context deadline exceeded") |
//                         hung (nothing answers but `docker desktop`)
//   <state>/mode.json     { mode, restart, forceStop } wins over FAKE_DOCKER_MODE (switch while the app runs);
//                         restart / forceStop: 'ok' (default: containers end, Docker comes back after
//                         FAKE_DOCKER_START_MS / stays off) | 'hang' | 'fail'. desktop.log lists the desktop commands run.
//   FAKE_DOCKER_OS        windows | linux: wording of daemon errors (default: this OS)
//   FAKE_DOCKER_START_MS  daemon-down: time from `desktop start` to running (default 300)
//   FAKE_DOCKER_MISSING   comma-separated image refs that are not present locally (until pulled)
//   FAKE_DOCKER_PULL_FAIL comma-separated image refs whose pull fails (manifest unknown)
//   FAKE_DOCKER_ENGINE    fake engine CLI (default ../fake-engine/cli.mjs)
//   FAKE_DOCKER_COPY_MS   busybox cp: pause after each copied file (default 0), so a copy can be observed or cancelled
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  appendFileSync,
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const env = process.env;
const ENGINE = env.FAKE_DOCKER_ENGINE ?? fileURLToPath(new URL('../fake-engine/cli.mjs', import.meta.url));
const STATE = env.FAKE_DOCKER_STATE ?? path.join(os.tmpdir(), 'gpubench-fake-docker');
// <state>/mode.json ({ mode, restart, forceStop }) wins over FAKE_DOCKER_MODE: tests and mockups switch Docker while the app runs.
const MODE_FILE = readJson('mode.json', {});
const MODE = MODE_FILE.mode ?? env.FAKE_DOCKER_MODE ?? 'running';
const WIN = (env.FAKE_DOCKER_OS ?? (process.platform === 'win32' ? 'windows' : 'linux')) === 'windows';
const VERSION = '29.8.0';

const out = (s) => process.stdout.write(s.endsWith('\n') ? s : `${s}\n`);
const err = (s) => process.stderr.write(s.endsWith('\n') ? s : `${s}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const list = (v) => (v ?? '').split(',').map((x) => x.trim()).filter(Boolean);

// ------------------------------------------------------------------------------------- state

function p(...parts) {
  return path.join(STATE, ...parts);
}

function readJson(file, fallback) {
  try {
    return JSON.parse(readFileSync(p(file), 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  mkdirSync(path.dirname(p(file)), { recursive: true });
  const tmp = p(`${file}.${process.pid}.${randomBytes(3).toString('hex')}.tmp`);
  writeFileSync(tmp, JSON.stringify(value, null, 2));
  for (let i = 0; ; i++) {
    try {
      renameSync(tmp, p(file));
      return;
    } catch (e) {
      // Windows: the target may be open in another fake process for a moment.
      if (i > 50) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
}

/** Containers with their exit info merged in (the runtime writes exit-<id>.json on its own). */
function containers() {
  const cs = readJson('containers.json', []);
  for (const c of cs) {
    const ex = readJson(`exit-${c.id}.json`, undefined);
    if (ex && c.state === 'running') {
      c.state = 'exited';
      c.exitCode = ex.exitCode;
      c.finishedAt = ex.finishedAt;
    }
  }
  return cs;
}

function saveContainers(cs) {
  writeJson('containers.json', cs);
}

function findContainer(ref) {
  return containers().find((c) => c.id === ref || c.id.startsWith(ref) || c.name === ref || `/${c.name}` === ref);
}

/** RFC3339Nano like the daemon writes it. */
function nowNano() {
  const iso = new Date().toISOString();
  const extra = String(process.hrtime.bigint() % 1000000n).padStart(6, '0');
  return iso.replace(/\.(\d{3})Z$/, `.$1${extra}Z`);
}

// ----------------------------------------------------------------------------------- daemon

function daemonState() {
  if (MODE === 'daemon-down' || MODE === 'no-desktop-plugin') {
    const d = readJson('daemon.json', {});
    if (d.startRequestedAt === undefined) return 'down';
    return Date.now() - d.startRequestedAt >= Number(env.FAKE_DOCKER_START_MS ?? 300) ? 'up' : 'starting';
  }
  if (MODE === 'starting') return 'starting';
  if (MODE === 'permission-denied') return 'permission';
  return 'up';
}

function daemonError(state) {
  if (state === 'permission') {
    return WIN
      ? 'permission denied while trying to connect to the docker API at npipe:////./pipe/dockerDesktopLinuxEngine: open //./pipe/dockerDesktopLinuxEngine: Access is denied.'
      : 'permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock: Get "http://%2Fvar%2Frun%2Fdocker.sock/v1.51/version": dial unix /var/run/docker.sock: connect: permission denied';
  }
  if (state === 'starting') {
    return 'request returned 500 Internal Server Error for API route and version http://%2F%2F.%2Fpipe%2FdockerDesktopLinuxEngine/v1.51/version, check if the server supports the requested API version';
  }
  return WIN
    ? 'failed to connect to the docker API at npipe:////./pipe/dockerDesktopLinuxEngine; check if the path is correct and if the daemon is running: open //./pipe/dockerDesktopLinuxEngine: The system cannot find the file specified.'
    : 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?';
}

/** What Docker Desktop's API proxy answers for an engine stuck stopping (it gave up after 15 s). */
const DEADLINE = 'Error response from daemon: request returned 500 Internal Server Error for API route and version http://%2F%2F.%2Fpipe%2FdockerDesktopLinuxEngine/v1.51/containers/create, check if the server supports the requested API version: context deadline exceeded';

/**
 * Commands that need the daemon fail like the real CLI when it is not reachable. "stuck": Docker
 * Desktop's API cache still answers reads (ps, inspect), anything that needs the engine fails.
 */
function requireDaemon(read = false) {
  if (MODE === 'stuck') {
    if (read) return true;
    err(DEADLINE);
    process.exitCode = 1;
    return false;
  }
  const s = daemonState();
  if (s === 'up') return true;
  err(daemonError(s));
  process.exitCode = 1;
  return false;
}

/** Docker Desktop stopping or restarting: every running container ends (like the real VM going away). */
async function killAll() {
  for (const c of containers().filter((x) => x.state === 'running')) {
    writeFileSync(p(`stopping-${c.id}`), '');
    killEngine(c.id, 'SIGKILL');
    await waitExit(c.id, 5000);
  }
}

/** Never answers (the CLI's caller times out and kills us). */
function hang() {
  setInterval(() => {}, 1 << 30);
  return new Promise(() => {});
}

// --------------------------------------------------------------------------------- commands

const WSL_SHIM = [
  '',
  "The command 'docker' could not be found in this WSL 2 distro.",
  'We recommend to activate the WSL integration in Docker Desktop settings.',
  '',
  'For details about using Docker Desktop with WSL 2, visit:',
  '',
  'https://docs.docker.com/go/wsl2/',
  '',
].join('\n');

function cmdVersion() {
  if (MODE === 'wsl-shim') {
    // Real capture: the shim prints its hint on stdout and exits 0.
    out(WSL_SHIM);
    return 0;
  }
  const client = {
    Version: VERSION,
    ApiVersion: '1.51',
    DefaultAPIVersion: '1.51',
    GitCommit: '88096ef',
    GoVersion: 'go1.24.8',
    Os: WIN ? 'windows' : 'linux',
    Arch: 'amd64',
    BuildTime: 'Thu Sep  3 21:53:38 2026',
    Context: WIN ? 'desktop-linux' : 'default',
  };
  const s = daemonState();
  if (s !== 'up') {
    out(JSON.stringify({ Client: client, Server: null }));
    err(daemonError(s));
    return 1;
  }
  const podman = MODE === 'podman';
  const server = {
    Platform: { Name: podman ? '' : WIN ? 'Docker Desktop 4.47.0 (210443)' : 'Docker Engine - Community' },
    Components: podman
      ? [{ Name: 'Podman Engine', Version: '5.2.0', Details: {} }]
      : [
          { Name: 'Engine', Version: VERSION, Details: { ApiVersion: '1.51', Os: 'linux' } },
          { Name: 'containerd', Version: '1.7.27', Details: {} },
          { Name: 'runc', Version: '1.2.5', Details: {} },
        ],
    Version: podman ? '5.2.0' : VERSION,
    ApiVersion: '1.51',
    MinAPIVersion: '1.24',
    Os: MODE === 'windows-containers' ? 'windows' : 'linux',
    Arch: 'amd64',
    KernelVersion: '6.6.87.2-microsoft-standard-WSL2',
  };
  if (podman) err('Emulate Docker CLI using podman. Create /etc/containers/nodocker to quiet msg.');
  out(JSON.stringify({ Client: client, Server: server }));
  return 0;
}

/** desktop.log: every `docker desktop` command that changes something, one per line (tests read it). */
function logDesktop(args) {
  mkdirSync(STATE, { recursive: true });
  appendFileSync(p('desktop.log'), `${args.join(' ')}\n`);
}

/** Docker Desktop goes down (and comes back after FAKE_DOCKER_START_MS when `starting`); a stuck engine is not stuck any more. */
function desktopDown(starting) {
  writeJson('mode.json', { ...MODE_FILE, mode: 'daemon-down' });
  writeJson('daemon.json', starting ? { startRequestedAt: Date.now() } : {});
}

/**
 * The Docker Desktop CLI plugin: start [--detach], restart, stop [--force], status --format json.
 * mode.json { restart, forceStop }: 'ok' (default) | 'hang' (never answers) | 'fail' (exit 1).
 */
async function cmdDesktop(args) {
  if (MODE === 'no-desktop-plugin') {
    err("docker: 'desktop' is not a docker command.\nSee 'docker --help'");
    return 1;
  }
  const [sub] = args;
  if (sub === 'status') {
    // Docker Desktop's backend hangs too when everything does.
    if (MODE === 'hung') return hang();
    if (MODE === 'stuck') {
      out(JSON.stringify({ Status: 'stopping', SessionID: 'fake-session' }));
      return 0;
    }
    const s = daemonState();
    if (s === 'down') {
      err('Could not retrieve status. Is Docker Desktop running?');
      return 1;
    }
    out(JSON.stringify({ Status: s === 'starting' ? 'starting' : 'running', SessionID: 'fake-session' }));
    return 0;
  }
  if (sub === 'restart' || sub === 'stop') {
    const how = (sub === 'restart' ? MODE_FILE.restart : MODE_FILE.forceStop) ?? 'ok';
    logDesktop(args);
    if (how === 'hang') return hang();
    if (how === 'fail') {
      err(`Error: could not ${sub} Docker Desktop: the backend did not answer`);
      return 1;
    }
    await killAll();
    desktopDown(sub === 'restart');
    return 0;
  }
  if (sub !== 'start') {
    err(`docker: unknown command: docker desktop ${sub ?? ''}`);
    return 1;
  }
  logDesktop(args);
  if (daemonState() === 'down') writeJson('daemon.json', { startRequestedAt: Date.now() });
  return 0;
}

const VALUE_OPTS = new Set(['--name', '--label', '-l', '--gpus', '--ipc', '-p', '--publish', '-v', '--volume', '-e', '--env', '--entrypoint', '--pull', '--network', '--shm-size', '--runtime', '-w', '--workdir', '-u', '--user']);
const BOOL_OPTS = new Set(['-d', '--detach', '--rm', '-i', '-t', '--init', '--privileged']);

function parseRun(args) {
  const o = { labels: {}, env: {}, ports: [], volumes: [], detach: false, rm: false };
  let i = 0;
  for (; i < args.length; i++) {
    let a = args[i];
    if (!a.startsWith('-')) break;
    let value;
    const eq = a.indexOf('=');
    if (a.startsWith('--') && eq > 0) {
      value = a.slice(eq + 1);
      a = a.slice(0, eq);
    }
    if (BOOL_OPTS.has(a)) {
      if (a === '-d' || a === '--detach') o.detach = true;
      if (a === '--rm') o.rm = true;
      continue;
    }
    if (!VALUE_OPTS.has(a)) return { error: `unknown flag: ${a}\nSee 'docker run --help'.` };
    if (value === undefined) value = args[++i];
    if (value === undefined) return { error: `flag needs an argument: ${a}\nSee 'docker run --help'.` };
    if (a === '--name') o.name = value;
    else if (a === '--label' || a === '-l') {
      const k = value.indexOf('=');
      o.labels[k < 0 ? value : value.slice(0, k)] = k < 0 ? '' : value.slice(k + 1);
    } else if (a === '--gpus') o.gpus = value;
    else if (a === '--ipc') o.ipc = value;
    else if (a === '-p' || a === '--publish') o.ports.push(parsePort(value));
    else if (a === '-v' || a === '--volume') o.volumes.push(parseVolume(value));
    else if (a === '-e' || a === '--env') {
      const k = value.indexOf('=');
      // `-e NAME` takes the value from the CLI's own environment (how secrets stay out of argv).
      if (k < 0) {
        if (env[value] !== undefined) o.env[value] = env[value];
      } else o.env[value.slice(0, k)] = value.slice(k + 1);
    } else if (a === '--entrypoint') o.entrypoint = value;
    else if (a === '--pull') o.pull = value;
  }
  o.image = args[i];
  o.args = args.slice(i + 1);
  if (!o.image) return { error: '"docker run" requires at least 1 argument.' };
  return o;
}

function parsePort(spec) {
  const parts = spec.split(':');
  if (parts.length === 3) return { ip: parts[0], host: Number(parts[1]), cont: Number(parts[2]) };
  if (parts.length === 2) return { ip: '0.0.0.0', host: Number(parts[0]), cont: Number(parts[1]) };
  return { ip: '0.0.0.0', host: 0, cont: Number(parts[0]) };
}

/** "C:\models\x:/models:ro" (drive letter), "/srv/m:/models", "gpubench-hf-cache:/root/.cache/huggingface". */
function parseVolume(spec) {
  const drive = /^[A-Za-z]:[\\/]/.test(spec);
  const idx = spec.indexOf(':', drive ? 2 : 0);
  const src = spec.slice(0, idx);
  const [dst, mode] = spec.slice(idx + 1).split(':');
  const named = !/[\\/]/.test(src);
  return { src, dst, ro: mode === 'ro', named, hostDir: named ? p('volumes', src) : src };
}

function missingImages() {
  const pulled = readJson('images.json', { pulled: [] }).pulled;
  return list(env.FAKE_DOCKER_MISSING).filter((r) => !pulled.includes(r));
}

function imageId(ref) {
  return `sha256:${createHash('sha256').update(`id:${ref}`).digest('hex')}`;
}

function repoOf(ref) {
  const at = ref.indexOf('@');
  const r = at >= 0 ? ref.slice(0, at) : ref;
  const c = r.lastIndexOf(':');
  return c > r.lastIndexOf('/') ? r.slice(0, c) : r;
}

function portFree(port, ip) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.listen({ port, host: ip === '0.0.0.0' ? '127.0.0.1' : ip, exclusive: true }, () => srv.close(() => resolve(true)));
  });
}

/** The engine command line inside the "container": host port, loopback host, host paths for mounts. */
function engineArgs(c) {
  const args = [...c.args];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--port' && args[i + 1] !== undefined) {
      const map = c.ports.find((x) => x.cont === Number(args[i + 1]));
      if (map) args[i + 1] = String(map.host);
    }
    if (args[i] === '--host' && args[i + 1] === '0.0.0.0') args[i + 1] = '127.0.0.1';
    for (const v of c.volumes) {
      const a = args[i];
      if (a === v.dst || a.startsWith(`${v.dst}/`)) args[i] = path.join(v.hostDir, a.slice(v.dst.length));
    }
  }
  return args;
}

function engineEnv(c) {
  return { ...env, ...c.env, FAKE_ENGINE_FLAVOR: /sglang/i.test(c.image) ? 'sglang' : /vllm/i.test(c.image) ? 'vllm' : 'llamacpp' };
}

async function cmdRun(args) {
  const o = parseRun(args);
  if (o.error) {
    err(`docker: ${o.error}`);
    return 125;
  }
  if (!requireDaemon()) return 1;
  if (missingImages().includes(o.image)) {
    if (o.pull === 'never') {
      err(`docker: Error response from daemon: No such image: ${o.image}\n\nRun 'docker run --help' for more information`);
      return 125;
    }
    err(`Unable to find image '${o.image}' locally`);
    err(`docker: Error response from daemon: pull access denied for ${repoOf(o.image)}, repository does not exist or may require 'docker login': denied: requested access to the resource is denied`);
    return 125;
  }
  const all = containers();
  if (o.name && all.some((c) => c.name === o.name)) {
    const other = all.find((c) => c.name === o.name);
    err(`docker: Error response from daemon: Conflict. The container name "/${o.name}" is already in use by container "${other.id}". You have to remove (or rename) that container to be able to reuse that name.`);
    return 125;
  }
  const id = randomBytes(32).toString('hex');
  const c = {
    id,
    name: o.name ?? `fake_${id.slice(0, 8)}`,
    image: o.image,
    imageId: imageId(o.image),
    labels: o.labels,
    env: o.env,
    ports: o.ports,
    volumes: o.volumes,
    args: o.args,
    gpus: o.gpus ?? null,
    ipc: o.ipc ?? null,
    entrypoint: o.entrypoint ?? null,
    state: 'created',
    createdAt: nowNano(),
  };

  // Failures after "create": like the daemon, they leave a Created container behind.
  const createdFailure = (message, code = 125) => {
    if (!o.rm) saveContainers([...containers(), c]);
    err(`docker: Error response from daemon: ${message}\n\nRun 'docker run --help' for more information`);
    return code;
  };
  if (o.gpus !== undefined && MODE === 'no-gpu') return createdFailure('could not select device driver "" with capabilities: [[gpu]]');
  if (o.gpus !== undefined && MODE === 'old-driver') {
    return createdFailure(
      'failed to create task for container: failed to create shim task: OCI runtime create failed: runc create failed: unable to start container process: error during container init: error running prestart hook #0: exit status 1, stdout: , stderr: Auto-detected mode as \'legacy\'\nnvidia-container-cli: requirement error: unsatisfied condition: cuda>=13.0, please update your driver to a newer version, or use an earlier cuda container: unknown',
    );
  }
  for (const port of o.ports) {
    if (port.host > 0 && !(await portFree(port.host, port.ip))) {
      return createdFailure(
        `driver failed programming external connectivity on endpoint ${c.name} (${id}): Bind for ${port.ip}:${port.host} failed: port is already allocated`,
      );
    }
  }
  for (const v of o.volumes) {
    if (!v.named && !existsSync(v.src)) return createdFailure(`invalid mount config for type "bind": bind source path does not exist: ${v.src}`);
  }
  // Like the daemon: a named volume that does not exist yet is created on first use.
  for (const v of o.volumes) if (v.named) ensureVolume(v.src, {});
  if (HELPER_IMAGE.test(repoOf(o.image)) && o.entrypoint === undefined) return runHelper(o);

  if (o.entrypoint !== undefined && o.entrypoint !== 'nvidia-smi') {
    return createdFailure(
      `failed to create task for container: failed to create shim task: OCI runtime create failed: runc create failed: unable to start container process: error during container init: exec: "${o.entrypoint}": executable file not found in $PATH: unknown`,
      127,
    );
  }
  if (o.entrypoint === 'nvidia-smi') {
    if (o.gpus === undefined) {
      out("NVIDIA-SMI has failed because it couldn't communicate with the NVIDIA driver. Make sure that the latest NVIDIA driver is installed and running.");
      return 9;
    }
    out('GPU 0: NVIDIA GeForce RTX 5090 (UUID: GPU-6d2e1c3a-0f4b-4c8e-9a51-2b7d3e9f1a04)');
    return 0;
  }

  if (!o.detach) {
    // Foreground: the engine's own output and exit code (capability probes: --version / --help).
    const r = spawnSync(process.execPath, [ENGINE, ...engineArgs(c)], { env: engineEnv(c), encoding: 'utf8', windowsHide: true });
    process.stdout.write(r.stdout ?? '');
    process.stderr.write(r.stderr ?? '');
    return r.status ?? 1;
  }

  c.state = 'running';
  c.startedAt = nowNano();
  saveContainers([...containers(), c]);
  mkdirSync(p('logs'), { recursive: true });
  writeFileSync(p('logs', `${id}.jsonl`), '');
  const runtime = spawn(process.execPath, [SELF, '__container', id], { detached: true, stdio: 'ignore', windowsHide: true, env });
  runtime.unref();
  out(id);
  return 0;
}

// ----------------------------------------------------------------------------- volumes + helper

/** busybox, docker.io/busybox, docker.io/library/busybox (any tag). */
const HELPER_IMAGE = /^(?:docker\.io\/(?:library\/)?)?busybox$/;

function volumes() {
  return readJson('volumes.json', []);
}

function ensureVolume(name, labels) {
  const all = volumes();
  if (!all.some((v) => v.name === name)) {
    all.push({ name, labels, createdAt: nowNano() });
    writeJson('volumes.json', all);
  }
  mkdirSync(p('volumes', name), { recursive: true });
}

function labelMatches(labels, filter) {
  const m = /^label=([^=]+)(?:=(.*))?$/.exec(filter);
  if (!m) return true;
  return m[2] === undefined ? m[1] in labels : labels[m[1]] === m[2];
}

function cmdVolume(args) {
  const [sub, ...rest] = args;
  if (!requireDaemon()) return 1;
  if (sub === 'create') {
    const labels = {};
    let name;
    for (let i = 0; i < rest.length; i++) {
      const a = rest[i];
      if (a === '--label' || a === '-l' || a.startsWith('--label=')) {
        const value = a.startsWith('--label=') ? a.slice('--label='.length) : rest[++i];
        const k = value.indexOf('=');
        labels[k < 0 ? value : value.slice(0, k)] = k < 0 ? '' : value.slice(k + 1);
      } else if (a === '-d' || a === '--driver' || a === '-o' || a === '--opt') i++;
      else if (a.startsWith('-')) {
        err(`unknown flag: ${a}\nSee 'docker volume create --help'.`);
        return 1;
      } else name = a;
    }
    name ??= randomBytes(32).toString('hex');
    ensureVolume(name, labels);
    out(name);
    return 0;
  }
  if (sub === 'inspect') {
    const all = volumes();
    const found = [];
    let code = 0;
    for (const n of rest.filter((a) => !a.startsWith('-'))) {
      const v = all.find((x) => x.name === n);
      if (!v) {
        err(`Error response from daemon: get ${n}: no such volume`);
        code = 1;
        continue;
      }
      found.push({ CreatedAt: v.createdAt, Driver: 'local', Labels: v.labels, Mountpoint: `/var/lib/docker/volumes/${n}/_data`, Name: n, Options: null, Scope: 'local' });
    }
    out(JSON.stringify(found, null, 4));
    return code;
  }
  if (sub === 'ls') {
    const filters = [];
    let format;
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === '--filter' || rest[i] === '-f') filters.push(rest[++i]);
      else if (rest[i] === '--format') format = rest[++i];
      else if (rest[i] === '-q' || rest[i] === '--quiet') format = '{{.Name}}';
    }
    const rows = volumes().filter((v) => filters.every((f) => labelMatches(v.labels, f)));
    if (format === '{{.Name}}') for (const v of rows) out(v.name);
    else {
      out('DRIVER    VOLUME NAME');
      for (const v of rows) out(`local     ${v.name}`);
    }
    return 0;
  }
  if (sub === 'rm') {
    const force = rest.includes('-f') || rest.includes('--force');
    let code = 0;
    for (const n of rest.filter((a) => !a.startsWith('-'))) {
      const all = volumes();
      if (!all.some((v) => v.name === n)) {
        // `rm -f` of a volume that is already gone is not an error.
        if (!force) {
          err(`Error response from daemon: get ${n}: no such volume`);
          code = 1;
        }
        continue;
      }
      writeJson('volumes.json', all.filter((v) => v.name !== n));
      rmSync(p('volumes', n), { recursive: true, force: true });
      out(n);
    }
    return code;
  }
  err(`docker: unknown command: docker volume ${sub ?? ''}\n\nRun 'docker volume --help' for more information`);
  return 1;
}

/** Bytes of the files under `dir` (real `du -sb` also counts directory entries; ModelVolumes caps at the total). */
function treeBytes(dir) {
  const st = statSync(dir);
  if (!st.isDirectory()) return st.size;
  return readdirSync(dir).reduce((n, name) => n + treeBytes(path.join(dir, name)), 0);
}

/** The busybox helper container: `cp SRC… DST` and `du -sb DIR…` on the mounted folders. */
async function runHelper(o) {
  const mounts = [...o.volumes].sort((a, b) => b.dst.length - a.dst.length);
  const host = (cp) => {
    const v = mounts.find((m) => cp === m.dst || cp.startsWith(`${m.dst.replace(/\/$/, '')}/`));
    return v ? { path: path.join(v.hostDir, cp.slice(v.dst.length)), ro: v.ro } : undefined;
  };
  const [cmd, ...args] = o.args;
  const operands = args.filter((a) => !a.startsWith('-'));
  if (cmd === 'cp') {
    const dst = operands.pop();
    if (dst === undefined || operands.length === 0) {
      err('BusyBox v1.37.0 multi-call binary.\n\nUsage: cp [-arPLHpfinlsTu] SOURCE DEST');
      return 1;
    }
    const d = host(dst);
    if (!d || d.ro) {
      err(`cp: can't create '${dst}': ${d ? 'Read-only file system' : 'No such file or directory'}`);
      return 1;
    }
    let code = 0;
    for (const src of operands) {
      const s = host(src);
      if (!s || !existsSync(s.path)) {
        err(`cp: can't stat '${src}': No such file or directory`);
        code = 1;
        continue;
      }
      const target = dst.endsWith('/') || (existsSync(d.path) && statSync(d.path).isDirectory()) ? path.join(d.path, path.posix.basename(src)) : d.path;
      copyFileSync(s.path, target);
      await sleep(Number(env.FAKE_DOCKER_COPY_MS ?? 0));
    }
    return code;
  }
  if (cmd === 'du') {
    let code = 0;
    for (const dir of operands) {
      const h = host(dir);
      if (!h || !existsSync(h.path)) {
        err(`du: ${dir}: No such file or directory`);
        code = 1;
        continue;
      }
      out(`${treeBytes(h.path)}\t${dir}`);
    }
    return code;
  }
  err(
    `docker: Error response from daemon: failed to create task for container: failed to create shim task: OCI runtime create failed: runc create failed: unable to start container process: error during container init: exec: "${cmd ?? ''}": executable file not found in $PATH: unknown`,
  );
  return 127;
}

/** The "container runtime": runs the engine and records its timestamped output and exit. */
async function cmdContainer(id) {
  const c = findContainer(id);
  if (!c) return 1;
  const logFile = p('logs', `${id}.jsonl`);
  const child = spawn(process.execPath, [ENGINE, ...engineArgs(c)], { env: engineEnv(c), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  writeJson(`pid-${id}.json`, { runtime: process.pid, engine: child.pid });
  const pump = (stream, name) => {
    let rest = '';
    stream.setEncoding('utf8');
    stream.on('data', (d) => {
      const parts = (rest + d).split(/\r?\n/);
      rest = parts.pop();
      for (const text of parts) appendFileSync(logFile, `${JSON.stringify({ ts: nowNano(), stream: name, text })}\n`);
    });
    return () => {
      if (rest) appendFileSync(logFile, `${JSON.stringify({ ts: nowNano(), stream: name, text: rest })}\n`);
      rest = '';
    };
  };
  const flushOut = pump(child.stdout, 'stdout');
  const flushErr = pump(child.stderr, 'stderr');
  const closed = Promise.all([new Promise((r) => child.stdout.on('end', r)), new Promise((r) => child.stderr.on('end', r))]);
  const exit = await new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
  await Promise.race([closed, sleep(1000)]);
  flushOut();
  flushErr();
  const stopping = existsSync(p(`stopping-${id}`));
  const exitCode = exit.code ?? (stopping ? 143 : 137);
  writeJson(`exit-${id}.json`, { exitCode: stopping && exitCode !== 0 ? 143 : exitCode, finishedAt: nowNano() });
  return 0;
}

function killEngine(id, signal) {
  const pids = readJson(`pid-${id}.json`, undefined);
  if (!pids) return;
  try {
    process.kill(pids.engine, signal);
  } catch {
    /* already gone */
  }
}

async function waitExit(id, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (existsSync(p(`exit-${id}.json`))) return true;
    await sleep(20);
  }
  return existsSync(p(`exit-${id}.json`));
}

async function cmdStop(args) {
  let t = 10;
  const ids = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-t' || args[i] === '--time' || args[i] === '--timeout') t = Number(args[++i]);
    else ids.push(args[i]);
  }
  if (!requireDaemon()) return 1;
  let code = 0;
  for (const ref of ids) {
    const c = findContainer(ref);
    if (!c) {
      err(`Error response from daemon: No such container: ${ref}`);
      code = 1;
      continue;
    }
    if (c.state === 'running') {
      writeFileSync(p(`stopping-${c.id}`), '');
      killEngine(c.id, 'SIGTERM');
      if (!(await waitExit(c.id, t * 1000))) {
        killEngine(c.id, 'SIGKILL');
        await waitExit(c.id, 5000);
      }
    }
    out(ref);
  }
  return code;
}

async function cmdRm(args) {
  const force = args.includes('-f') || args.includes('--force');
  const ids = args.filter((a) => !a.startsWith('-'));
  if (!requireDaemon()) return 1;
  let code = 0;
  for (const ref of ids) {
    const c = findContainer(ref);
    if (!c) {
      err(`Error response from daemon: No such container: ${ref}`);
      code = 1;
      continue;
    }
    if (c.state === 'running') {
      if (!force) {
        err(`Error response from daemon: cannot remove container "/${c.name}": container is running: stop the container before removing or force remove`);
        code = 1;
        continue;
      }
      writeFileSync(p(`stopping-${c.id}`), '');
      killEngine(c.id, 'SIGKILL');
      await waitExit(c.id, 5000);
    }
    saveContainers(containers().filter((x) => x.id !== c.id));
    for (const f of [`exit-${c.id}.json`, `pid-${c.id}.json`, `stopping-${c.id}`, path.join('logs', `${c.id}.jsonl`)]) rmSync(p(f), { force: true });
    out(ref);
  }
  return code;
}

async function cmdLogs(args) {
  const follow = args.includes('-f') || args.includes('--follow');
  const stamps = args.includes('-t') || args.includes('--timestamps');
  const ref = args.filter((a) => !a.startsWith('-'))[0];
  if (!requireDaemon()) return 1;
  const c = findContainer(ref ?? '');
  if (!c) {
    err(`Error response from daemon: No such container: ${ref}`);
    return 1;
  }
  const file = p('logs', `${c.id}.jsonl`);
  let offset = 0;
  let rest = '';
  const drain = () => {
    let size;
    try {
      size = statSync(file).size;
    } catch {
      return;
    }
    if (size <= offset) return;
    const fd = openSync(file, 'r');
    const buf = Buffer.alloc(size - offset);
    readSync(fd, buf, 0, buf.length, offset);
    closeSync(fd);
    offset = size;
    const parts = (rest + buf.toString('utf8')).split('\n');
    rest = parts.pop();
    for (const line of parts) {
      if (!line) continue;
      const e = JSON.parse(line);
      const text = stamps ? `${e.ts} ${e.text}\n` : `${e.text}\n`;
      (e.stream === 'stderr' ? process.stderr : process.stdout).write(text);
    }
  };
  drain();
  while (follow) {
    const exited = existsSync(p(`exit-${c.id}.json`)) || !findContainer(c.id);
    drain();
    if (exited) break;
    await sleep(20);
  }
  return 0;
}

function psRow(c) {
  return {
    Command: `"${c.args.join(' ')}"`,
    CreatedAt: c.createdAt,
    ID: c.id,
    Image: c.image,
    Labels: Object.entries(c.labels)
      .map(([k, v]) => `${k}=${v}`)
      .join(','),
    LocalVolumes: '0',
    Mounts: c.volumes.map((v) => v.dst).join(','),
    Names: c.name,
    Networks: 'bridge',
    Ports: c.ports.map((x) => `${x.ip}:${x.host}->${x.cont}/tcp`).join(', '),
    RunningFor: 'About a minute ago',
    Size: '0B',
    State: c.state,
    Status: c.state === 'running' ? 'Up About a minute' : c.state === 'exited' ? `Exited (${c.exitCode}) 5 seconds ago` : 'Created',
  };
}

function cmdPs(args) {
  if (!requireDaemon(true)) return 1;
  const all = args.includes('-a') || args.includes('--all');
  const filters = [];
  let format;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--filter' || args[i] === '-f') filters.push(args[++i]);
    else if (args[i] === '--format') format = args[++i];
  }
  const rows = containers().filter((c) => {
    if (!all && c.state !== 'running') return false;
    return filters.every((f) => {
      const m = /^label=([^=]+)(?:=(.*))?$/.exec(f);
      if (!m) return true;
      return m[2] === undefined ? m[1] in c.labels : c.labels[m[1]] === m[2];
    });
  });
  if (format === '{{json .}}' || format === 'json') {
    for (const c of rows) out(JSON.stringify(psRow(c)));
  } else {
    out('CONTAINER ID   IMAGE   COMMAND   CREATED   STATUS   PORTS   NAMES');
    for (const c of rows) out(`${c.id.slice(0, 12)}   ${c.image}   "${c.args[0] ?? ''}"   now   ${psRow(c).Status}      ${c.name}`);
  }
  return 0;
}

function inspectJson(c) {
  const pids = readJson(`pid-${c.id}.json`, {});
  return {
    Id: c.id,
    Created: c.createdAt,
    Path: c.entrypoint ?? '/app/entrypoint',
    Args: c.args,
    State: {
      Status: c.state,
      Running: c.state === 'running',
      Paused: false,
      Restarting: false,
      OOMKilled: false,
      Dead: false,
      Pid: c.state === 'running' ? (pids.engine ?? 0) : 0,
      ExitCode: c.exitCode ?? 0,
      Error: '',
      StartedAt: c.startedAt ?? '0001-01-01T00:00:00Z',
      FinishedAt: c.finishedAt ?? '0001-01-01T00:00:00Z',
    },
    Image: c.imageId,
    Name: `/${c.name}`,
    Config: { Image: c.image, Labels: c.labels, Env: Object.keys(c.env).map((k) => `${k}=${c.env[k]}`) },
  };
}

function cmdInspect(args) {
  const refs = args.filter((a) => !a.startsWith('-'));
  if (!requireDaemon(true)) return 1;
  const found = [];
  let code = 0;
  for (const r of refs) {
    const c = findContainer(r);
    if (c) found.push(inspectJson(c));
    else {
      err(`Error: No such container: ${r}`);
      code = 1;
    }
  }
  out(JSON.stringify(found, null, 4));
  return code;
}

function cmdImageInspect(args) {
  const refs = args.filter((a) => !a.startsWith('-'));
  if (!requireDaemon(true)) return 1;
  const missing = missingImages();
  const found = [];
  let code = 0;
  for (const r of refs) {
    if (missing.includes(r)) {
      err(`Error response from daemon: No such image: ${r}`);
      code = 1;
      continue;
    }
    found.push({
      Id: imageId(r),
      RepoTags: r.includes('@') ? [] : [r],
      RepoDigests: [`${repoOf(r)}@sha256:${createHash('sha256').update(`digest:${r}`).digest('hex')}`],
      Size: 9_035_211_086,
      Os: 'linux',
      Architecture: 'amd64',
    });
  }
  out(JSON.stringify(found, null, 4));
  return code;
}

async function cmdPull(args) {
  const ref = args.filter((a) => !a.startsWith('-'))[0];
  if (!requireDaemon()) return 1;
  if (list(env.FAKE_DOCKER_PULL_FAIL).includes(ref)) {
    err(`Error response from daemon: manifest for ${ref} not found: manifest unknown: manifest unknown`);
    return 1;
  }
  const tag = ref.includes(':') ? ref.slice(ref.lastIndexOf(':') + 1) : 'latest';
  out(`${tag}: Pulling from ${repoOf(ref)}`);
  const layers = ['a1b2c3d4e5f6', 'b2c3d4e5f6a1', 'c3d4e5f6a1b2'];
  for (const l of layers) out(`${l}: Pulling fs layer`);
  for (const l of layers) {
    await sleep(5);
    out(`${l}: Verifying Checksum`);
    out(`${l}: Download complete`);
  }
  for (const l of layers) out(`${l}: Pull complete`);
  out(`Digest: sha256:${createHash('sha256').update(`digest:${ref}`).digest('hex')}`);
  out(`Status: Downloaded newer image for ${ref}`);
  out(ref);
  const st = readJson('images.json', { pulled: [] });
  if (!st.pulled.includes(ref)) st.pulled.push(ref);
  writeJson('images.json', st);
  return 0;
}

async function cmdApi(args) {
  const i = args.indexOf('--socket');
  const { startFakeDockerApi } = await import('./api.mjs');
  const api = await startFakeDockerApi(i >= 0 ? { socketPath: args[i + 1] } : {});
  out(api.socketPath);
  return undefined;
}

async function main(argv) {
  // Global flags the real CLI accepts before the command.
  while (argv[0] === '--context' || argv[0] === '-H' || argv[0] === '--host') argv = argv.slice(2);
  const [cmd, ...rest] = argv;
  // "hung": Docker Desktop is up but nothing behind it answers (only its own CLI plugin can restart it).
  if (MODE === 'hung' && cmd !== 'desktop' && cmd !== '__container' && cmd !== '__api') return hang();
  switch (cmd) {
    case 'version':
      return cmdVersion();
    case 'desktop':
      return cmdDesktop(rest);
    case 'run':
      return cmdRun(rest);
    case 'logs':
      return cmdLogs(rest);
    case 'stop':
      return cmdStop(rest);
    case 'rm':
      return cmdRm(rest);
    case 'ps':
      return cmdPs(rest);
    case 'inspect':
      return cmdInspect(rest);
    case 'container':
      if (rest[0] === 'inspect') return cmdInspect(rest.slice(1));
      if (rest[0] === 'rm') return cmdRm(rest.slice(1));
      if (rest[0] === 'stop') return cmdStop(rest.slice(1));
      break;
    case 'image':
      if (rest[0] === 'inspect') return cmdImageInspect(rest.slice(1));
      if (rest[0] === 'pull') return cmdPull(rest.slice(1));
      break;
    case 'pull':
      return cmdPull(rest);
    case 'volume':
      return cmdVolume(rest);
    case '__container':
      return cmdContainer(rest[0]);
    case '__api':
      return cmdApi(rest);
    default:
      break;
  }
  err(`docker: unknown command: docker ${argv.join(' ')}\n\nRun 'docker --help' for more information`);
  return 1;
}

main(process.argv.slice(2)).then(
  (code) => {
    if (code !== undefined) process.exitCode = code;
  },
  (e) => {
    err(`fake-docker: ${e?.stack ?? e}`);
    process.exitCode = 70;
  },
);
