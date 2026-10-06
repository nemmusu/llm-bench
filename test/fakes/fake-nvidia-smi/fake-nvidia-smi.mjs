#!/usr/bin/env node
/**
 * Fake nvidia-smi for tests (plain Node ESM, no dependencies):
 *   node test/fakes/fake-nvidia-smi/fake-nvidia-smi.mjs [args]
 * Wire it with CoreEndpoints.nvidiaSmi = [process.execPath, '<this file>'] (or GPUBENCH_NVIDIA_SMI='["node","…"]').
 *
 * Emulated subset (output formats copied from real driver 617.14 captures in test/fixtures/nvidia-smi):
 *   (no args)                                   header + process table
 *   --version                                   617 style (KMD / CUDA UMD); legacy: R535 style
 *   --query-gpu=<fields> --format=csv[,noheader][,nounits] [-lms N | --loop-ms=N | -l N | --loop=N]
 *   --query-compute-apps=pid,process_name,used_memory --format=…
 *   unknown field → 'Field "x" is not a valid field to query.' on stdout, exit 2
 * With -lms the state is re-read every interval and one line per GPU is printed until killed.
 *
 * Env:
 *   FAKE_NVIDIA_SMI_STATE      path to a JSON state file (missing/corrupt → defaults / last good state)
 *   FAKE_NVIDIA_SMI_MODE       "absent" → driver-missing message, exit 9; "nodevices" → exit 6
 *   FAKE_NVIDIA_SMI_EXIT_AFTER in loop mode, exit(1) after this many intervals (tests the restart path)
 *
 * State (every key optional; gpus[i] is merged over the RTX 5090 defaults below):
 *   {"gpus":[{"name":"NVIDIA GeForce RTX 5090","uuid":"GPU-…","memTotalMiB":32607,"memUsedMiB":1600,
 *     "utilPct":2,"powerW":35,"tempC":40,"smMHz":180,"memMHz":405,"throttle":"0x0000000000000001",
 *     "pcieGen":1,"pcieWidth":16,"pcieGenMax":5,"pcieWidthMax":16,"powerLimitW":575,"computeCap":"12.0"}],
 *    "apps":[{"pid":1234,"name":"llama-server.exe","usedMiB":null}],
 *    "driver":"617.14","cuda":"13.4",
 *    "legacy":false,               // true: old driver, see LEGACY_UNSUPPORTED (or "unsupportedFields")
 *    "unsupportedFields":["…"],    // explicit list of rejected fields (overrides the legacy default)
 *    "naFields":["power.draw.instant"]}  // fields printed as [N/A]
 * The fake engine (another test helper) read-modify-writes gpus[0].memUsedMiB/powerW/utilPct during
 * fake loads, so VRAM really rises while a model "loads".
 */
import { readFileSync } from 'node:fs';

const DEFAULT_GPU = {
  name: 'NVIDIA GeForce RTX 5090',
  uuid: 'GPU-3d36b2ac-a47c-233d-3308-4c71f3bc4a30',
  memTotalMiB: 32607,
  memUsedMiB: 1600,
  utilPct: 2,
  powerW: 35,
  tempC: 40,
  smMHz: 180,
  memMHz: 405,
  throttle: '0x0000000000000001',
  pcieGen: 1,
  pcieWidth: 16,
  pcieGenMax: 5,
  pcieWidthMax: 16,
  powerLimitW: 575,
  computeCap: '12.0',
};

/** Fields an R470-era driver does not know (aliases introduced later). */
const LEGACY_UNSUPPORTED = ['power.draw.instant', 'clocks_event_reasons.active', 'compute_cap', 'kmd_version'];

let lastGood = { gpus: [DEFAULT_GPU], apps: [], driver: '617.14', cuda: '13.4', legacy: false };

function readState() {
  const file = process.env.FAKE_NVIDIA_SMI_STATE;
  if (!file) return lastGood;
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    const gpus = Array.isArray(raw.gpus) && raw.gpus.length > 0 ? raw.gpus : [{}];
    lastGood = {
      gpus: gpus.map((g) => ({ ...DEFAULT_GPU, ...g })),
      apps: Array.isArray(raw.apps) ? raw.apps : [],
      driver: raw.driver ?? '617.14',
      cuda: raw.cuda ?? '13.4',
      legacy: raw.legacy === true,
      unsupportedFields: raw.unsupportedFields,
      naFields: raw.naFields,
    };
  } catch {
    // Missing file → defaults; a half-written file (concurrent writer) → keep the last good state.
  }
  return lastGood;
}

function unsupported(state) {
  if (Array.isArray(state.unsupportedFields)) return state.unsupportedFields;
  return state.legacy ? LEGACY_UNSUPPORTED : [];
}

const power = (w) => Number(w).toFixed(2);

/** Field value (nounits form) for one GPU. undefined = unknown field. */
function value(field, gpu, index, state) {
  if (Array.isArray(state.naFields) && state.naFields.includes(field)) return '[N/A]';
  switch (field) {
    case 'index':
      return String(index);
    case 'count':
      return String(state.gpus.length);
    case 'name':
    case 'gpu_name':
      return gpu.name;
    case 'uuid':
    case 'gpu_uuid':
      return gpu.uuid;
    case 'driver_version':
    case 'kmd_version':
      return state.driver;
    case 'memory.total':
      return String(gpu.memTotalMiB);
    case 'memory.used':
      return String(gpu.memUsedMiB);
    case 'memory.free':
      return String(gpu.memTotalMiB - gpu.memUsedMiB);
    case 'utilization.gpu':
      return String(gpu.utilPct);
    case 'power.draw':
    case 'power.draw.instant':
    case 'power.draw.average':
      return power(gpu.powerW);
    case 'power.limit':
      return power(gpu.powerLimitW);
    case 'temperature.gpu':
      return String(gpu.tempC);
    case 'clocks.sm':
    case 'clocks.current.sm':
      return String(gpu.smMHz);
    case 'clocks.mem':
    case 'clocks.current.memory':
      return String(gpu.memMHz);
    case 'pcie.link.gen.current':
      return String(gpu.pcieGen);
    case 'pcie.link.width.current':
      return String(gpu.pcieWidth);
    case 'pcie.link.gen.max':
      return String(gpu.pcieGenMax);
    case 'pcie.link.width.max':
      return String(gpu.pcieWidthMax);
    case 'compute_cap':
      return gpu.computeCap;
    case 'clocks_event_reasons.active':
    case 'clocks_throttle_reasons.active':
      return gpu.throttle;
    case 'pstate':
      return gpu.utilPct > 10 ? 'P1' : 'P8';
    default:
      return undefined;
  }
}

const UNITS = {
  'memory.total': ' MiB',
  'memory.used': ' MiB',
  'memory.free': ' MiB',
  'utilization.gpu': ' %',
  'power.draw': ' W',
  'power.draw.instant': ' W',
  'power.draw.average': ' W',
  'power.limit': ' W',
  'clocks.sm': ' MHz',
  'clocks.mem': ' MHz',
};

const out = (s) => process.stdout.write(s);

function fail(message, code) {
  out(`${message}\n\n`);
  process.exit(code);
}

function checkMode() {
  const mode = process.env.FAKE_NVIDIA_SMI_MODE;
  if (mode === 'absent') {
    fail(
      "NVIDIA-SMI has failed because it couldn't communicate with the NVIDIA driver. Make sure that the latest NVIDIA driver is installed and running.",
      9,
    );
  }
  if (mode === 'nodevices') fail('No devices were found', 6);
}

function header(state) {
  const g = state.gpus[0];
  const date = new Date().toString().slice(0, 24);
  if (state.legacy) {
    out(`${date}       \n`);
    out('+-----------------------------------------------------------------------------+\n');
    out(`| NVIDIA-SMI ${state.driver}   Driver Version: ${state.driver}   CUDA Version: ${state.cuda}     |\n`);
    out('+-----------------------------------------------------------------------------+\n');
    return;
  }
  out(`${date}       \n`);
  out('+-----------------------------------------------------------------------------------------+\n');
  out(`| NVIDIA-SMI ${state.driver}                 KMD Version: ${state.driver}        CUDA UMD Version: ${state.cuda}     |\n`);
  out('+-----------------------------------------+------------------------+----------------------+\n');
  state.gpus.forEach((gpu, i) => {
    out(`|   ${i}  ${gpu.name.padEnd(26)}  WDDM  |   00000000:0${i + 2}:00.0  On |                  N/A |\n`);
    out(`|  0%   ${gpu.tempC}C    P8   ${String(Math.round(gpu.powerW)).padStart(6)}W /  ${gpu.powerLimitW}W |  ${String(gpu.memUsedMiB).padStart(6)}MiB / ${gpu.memTotalMiB}MiB |  ${String(gpu.utilPct).padStart(5)}%      Default |\n`);
  });
  out('+-----------------------------------------------------------------------------------------+\n');
  out(`|  Processes: ${String(state.apps.length)} (fake ${g.name})\n`);
}

function version(state) {
  if (state.legacy) {
    out(`NVIDIA-SMI version  : ${state.driver}\nNVML version        : ${state.driver}\nDRIVER version      : ${state.driver}\nCUDA Version        : ${state.cuda}\n`);
    return;
  }
  out(`NVIDIA-SMI version  : ${state.driver}\nNVML version        : ${state.driver}\n`);
  out('DRIVER version      : Deprecated, see "KMD version" instead\nCUDA version        : Deprecated, see "CUDA UMD version" instead\n');
  out(`KMD version         : ${state.driver}\nCUDA UMD version    : ${state.cuda}\n`);
}

function parseArgs(argv) {
  const a = { query: undefined, apps: undefined, format: 'csv', loopMs: undefined, version: false, other: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => argv[++i];
    if (arg.startsWith('--query-gpu=')) a.query = arg.slice('--query-gpu='.length);
    else if (arg.startsWith('--query-compute-apps=')) a.apps = arg.slice('--query-compute-apps='.length);
    else if (arg.startsWith('--format=')) a.format = arg.slice('--format='.length);
    else if (arg === '-lms') a.loopMs = Number(next());
    else if (arg.startsWith('--loop-ms=')) a.loopMs = Number(arg.slice('--loop-ms='.length));
    else if (arg === '-l') a.loopMs = Number(next()) * 1000;
    else if (arg.startsWith('--loop=')) a.loopMs = Number(arg.slice('--loop='.length)) * 1000;
    else if (arg === '--version') a.version = true;
    else a.other.push(arg);
  }
  return a;
}

function csvLines(fields, rows, fmt) {
  const opts = new Set(fmt.split(',').slice(1));
  const lines = [];
  if (!opts.has('noheader')) lines.push(fields.map((f) => (opts.has('nounits') || !UNITS[f] ? f : `${f} [${UNITS[f].trim()}]`)).join(', '));
  for (const row of rows) {
    lines.push(row.map((v, i) => (opts.has('nounits') || !UNITS[fields[i]] || v.startsWith('[') ? v : `${v}${UNITS[fields[i]]}`)).join(', '));
  }
  return lines;
}

/** Validates fields like the real tool (first unknown field wins). */
function checkFields(fields, state, known) {
  const rejected = unsupported(state);
  for (const f of fields) if (rejected.includes(f) || !known(f)) fail(`Field "${f}" is not a valid field to query.`, 2);
}

function gpuRows(fields, state) {
  return state.gpus.map((gpu, i) => fields.map((f) => value(f, gpu, i, state)));
}

const APP_FIELDS = { pid: (a) => String(a.pid), process_name: (a) => a.name, used_memory: (a) => (a.usedMiB == null ? '[N/A]' : String(a.usedMiB)) };

function appRows(fields, state) {
  return state.apps.map((a) => fields.map((f) => APP_FIELDS[f](a)));
}

function main() {
  checkMode();
  const args = parseArgs(process.argv.slice(2));
  const state = readState();
  if (args.version) return version(state);
  if (args.apps !== undefined) {
    const fields = args.apps.split(',').map((f) => f.trim());
    checkFields(fields, state, (f) => f in APP_FIELDS);
    for (const l of csvLines(fields, appRows(fields, state), args.format)) out(`${l}\n`);
    return;
  }
  if (args.query === undefined) {
    if (args.other.length > 0) fail(`Invalid combination of input arguments. Please run 'nvidia-smi -h' for help.`, 2);
    return header(state);
  }
  const fields = args.query.split(',').map((f) => f.trim());
  checkFields(fields, state, (f) => value(f, DEFAULT_GPU, 0, { ...state, naFields: [] }) !== undefined);
  const print = (s, withHeader) => {
    const lines = csvLines(fields, gpuRows(fields, s), args.format);
    for (const l of withHeader ? lines : lines.slice(lines.length - s.gpus.length)) out(`${l}\n`);
  };
  if (!args.loopMs) return print(state, true);
  let loops = 0;
  const exitAfter = Number(process.env.FAKE_NVIDIA_SMI_EXIT_AFTER ?? 0);
  print(state, true);
  setInterval(() => {
    loops++;
    if (exitAfter > 0 && loops >= exitAfter) process.exit(1);
    print(readState(), false);
  }, Math.max(10, args.loopMs));
}

main();
