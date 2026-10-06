import { describe, expect, it } from 'vitest';
import { CLOCK_EVENT_REASONS, decodeClockEventReasons, isThrottled } from '../../../../src/core/telemetry/clock-reasons';
import {
  activeFields,
  byKey,
  initialChoice,
  lines,
  minimalChoice,
  num,
  splitRow,
  text,
  unsupportedField,
  withoutField,
  type FieldSpec,
} from '../../../../src/core/telemetry/fields';
import { gpuUserKind, isKnownLlm, processBaseName } from '../../../../src/core/telemetry/known-llm';
import {
  PROBE_FIELDS,
  SAMPLE_FIELDS,
  parseComputeApps,
  parseProbe,
  parseSampleRow,
  parseSamples,
} from '../../../../src/core/telemetry/parse';
import { fixture } from './fakes';

const sampleFields = activeFields(SAMPLE_FIELDS, initialChoice(SAMPLE_FIELDS));
const probeFields = activeFields(PROBE_FIELDS, initialChoice(PROBE_FIELDS));

describe('fields', () => {
  const specs: FieldSpec[] = [
    { key: 'index', names: ['index'], required: true },
    { key: 'a', names: ['a.new', 'a.old'], minimal: true },
    { key: 'b', names: ['b'] },
  ];

  it('builds initial, minimal and active field lists', () => {
    expect(initialChoice(specs)).toEqual({ index: 'index', a: 'a.new', b: 'b' });
    expect(minimalChoice(specs)).toEqual({ index: 'index', a: 'a.new', b: null });
    expect(activeFields(specs, { index: 'index', a: null, b: 'b' })).toEqual([
      { key: 'index', name: 'index' },
      { key: 'b', name: 'b' },
    ]);
  });

  it('switches a rejected field to its alias, then drops it; refuses required or unknown fields', () => {
    const c1 = withoutField(specs, initialChoice(specs), 'a.new');
    expect(c1).toEqual({ index: 'index', a: 'a.old', b: 'b' });
    expect(withoutField(specs, c1!, 'a.old')).toEqual({ index: 'index', a: null, b: 'b' });
    expect(withoutField(specs, initialChoice(specs), 'index')).toBeUndefined();
    expect(withoutField(specs, initialChoice(specs), 'nope')).toBeUndefined();
  });

  it('detects the unsupported-field message from real Windows and WSL captures', () => {
    expect(unsupportedField(fixture('nvidia-smi/win-unsupported-field.txt'))).toBe('bogus.field');
    expect(unsupportedField(fixture('nvidia-smi/wsl-unsupported-field.txt'))).toBe('bogus.field');
    expect(unsupportedField(fixture('nvidia-smi/handmade/legacy-unsupported-field.txt'))).toBe('power.draw.instant');
    expect(unsupportedField('Some field is not a valid field to query')).toBe('');
    expect(unsupportedField(fixture('nvidia-smi/win-probe.csv'))).toBeUndefined();
  });

  it('splits rows, merging commas back into the free-text column', () => {
    expect(splitRow(' a , b ,c', 3)).toEqual(['a', 'b', 'c']);
    expect(splitRow('a,b', 3)).toBeUndefined();
    expect(splitRow('a,b,c,d', 3)).toBeUndefined();
    expect(splitRow('1, Quadro, Inc., 4096', 3, 1)).toEqual(['1', 'Quadro, Inc.', '4096']);
    expect(splitRow('1, x', 3, 1)).toBeUndefined();
  });

  it('parses numbers and text, treating placeholders as null', () => {
    expect(num(' 575.00 ')).toBe(575);
    expect(num('575.00 W')).toBe(575);
    expect(num('4 %')).toBe(4);
    expect(num('-1')).toBe(-1);
    for (const v of ['[N/A]', '[Not Supported]', 'N/A', '', '0x10', 'abc', undefined]) expect(num(v)).toBeNull();
    expect(text(' RTX ')).toBe('RTX');
    for (const v of ['[N/A]', '[Insufficient Permissions]', 'N/A', '  ', undefined]) expect(text(v)).toBeNull();
    expect(byKey([{ key: 'k', name: 'n' }], ['v'])).toEqual({ k: 'v' });
    expect(lines('a\r\n\r\n b \n')).toEqual(['a', 'b']);
  });
});

describe('clock event reasons', () => {
  it('decodes the real idle RTX 5090 mask (0x400 = reliability)', () => {
    const [, active] = fixture('nvidia-smi/win-clock-reasons.csv').split(/\r?\n/)[1]!.split(', ');
    expect(decodeClockEventReasons(active)).toEqual(['reliability']);
    expect(decodeClockEventReasons('0x00000000000007FF')).toEqual(CLOCK_EVENT_REASONS.map(([, n]) => n));
  });

  it('decodes combined bits in bit order and keeps unknown bits', () => {
    expect(decodeClockEventReasons('0x00000000000000C4')).toEqual(['sw_power_cap', 'hw_thermal_slowdown', 'hw_power_brake_slowdown']);
    expect(decodeClockEventReasons('0x0000000000000000')).toEqual([]);
    expect(decodeClockEventReasons('0x8001')).toEqual(['gpu_idle', 'unknown_0x8000']);
    expect(decodeClockEventReasons('0xFFFFFFFFFFFFFFFF').at(-1)).toBe('unknown_0xfffffffffffff800');
  });

  it('returns no reasons for placeholders and garbage', () => {
    for (const v of ['[Not Supported]', '[N/A]', '', 'zz', undefined]) expect(decodeClockEventReasons(v)).toEqual([]);
  });

  it('tells real throttling from informational reasons', () => {
    expect(isThrottled(['gpu_idle', 'reliability', 'applications_clocks_setting'])).toBe(false);
    expect(isThrottled(['gpu_idle', 'sw_thermal_slowdown'])).toBe(true);
    expect(isThrottled([])).toBe(false);
  });
});

describe('known LLM servers', () => {
  it('matches executable base names with or without .exe, any case', () => {
    for (const n of [
      'C:\\llama\\b10997\\llama-server.exe',
      '/opt/llama.cpp/build/bin/llama-server',
      'LLAMA-CLI.EXE',
      'llama-bench',
      'C:\\Users\\u\\AppData\\Local\\Programs\\Ollama\\ollama.exe',
      'ollama_llama_server',
      'lms.exe',
      'C:\\Program Files\\LM Studio\\LM Studio.exe',
      '/opt/lm-studio',
      'koboldcpp.exe',
      'koboldcpp_cu12.exe',
      '/usr/bin/koboldcpp-linux-x64-cuda1210',
      'text-generation-launcher',
      'text-generation-server',
      'tabbyAPI',
      'sglang',
      '/usr/local/bin/vllm',
      'VLLM::EngineCore',
      'VLLM::Worker_TP1',
    ]) {
      expect(isKnownLlm(n), n).toBe(true);
    }
  });

  it('classifies GPU users: llm, vm, system desktop, app', () => {
    expect(gpuUserKind('C:\\llama\\llama-server.exe')).toBe('llm');
    expect(gpuUserKind('VLLM::Worker_TP0')).toBe('llm');
    for (const n of ['vmwp', 'vmmem', 'vmmemWSL', 'C:\\Windows\\System32\\vmwp.exe', 'Docker Desktop.exe']) expect(gpuUserKind(n), n).toBe('vm');
    for (const n of ['dwm', 'csrss.exe', 'C:\\Windows\\explorer.exe', 'SearchHost.exe', 'TextInputHost', 'ShellExperienceHost', 'System', '/usr/lib/xorg/Xorg', 'gnome-shell']) {
      expect(gpuUserKind(n), n).toBe('system');
    }
    for (const n of ['firefox', 'ChatGPT.exe', 'C:\\Program Files\\Mozilla Firefox\\firefox.exe', '/usr/bin/python3', 'electron']) expect(gpuUserKind(n), n).toBe('app');
    // Every process of the real WDDM list classifies (desktop shell parts as system, the rest as apps).
    const kinds = parseComputeApps(fixture('process-vram/win-compute-apps.csv')).map((a) => [processBaseName(a.processName), gpuUserKind(a.processName)]);
    expect(Object.fromEntries(kinds)).toMatchObject({ 'explorer.exe': 'system', 'firefox.exe': 'app', 'StartMenuExperienceHost.exe': 'system', 'claude.exe': 'app' });
  });

  it('never flags desktop apps or unresolvable interpreters', () => {
    const apps = fixture('nvidia-smi/win-compute-apps.csv');
    for (const app of parseComputeApps(apps)) expect(isKnownLlm(app.processName), app.processName).toBe(false);
    for (const n of ['python.exe', '/usr/bin/python3', 'node', 'llama-server-wrapper.sh', 'kobold.exe', 'explorer.exe']) {
      expect(isKnownLlm(n), n).toBe(false);
    }
  });

  it('takes the last path segment of Windows and POSIX paths', () => {
    expect(processBaseName('C:\\Windows\\explorer.exe')).toBe('explorer.exe');
    expect(processBaseName(' /usr/bin/python3 ')).toBe('python3');
    expect(processBaseName('[Insufficient Permissions]')).toBe('[Insufficient Permissions]');
    expect(processBaseName('C:\\weird\\')).toBe('C:\\weird\\');
  });
});

describe('probe CSV', () => {
  it('parses the real Windows and WSL probes (identical GPU, KMD driver)', () => {
    for (const f of ['nvidia-smi/win-probe.csv', 'nvidia-smi/wsl-probe.csv']) {
      const [gpu] = parseProbe(fixture(f, { crlf: f.startsWith('nvidia-smi/win') }), probeFields, { cudaVersion: '13.4' });
      expect(gpu).toMatchObject({
        index: 0,
        uuid: 'GPU-3d36b2ac-a47c-233d-3308-4c71f3bc4a30',
        name: 'NVIDIA GeForce RTX 5090',
        vendor: 'nvidia',
        memoryTotalMiB: 32607,
        driverVersion: '617.14',
        cudaVersion: '13.4',
        computeCapability: '12.0',
        powerLimitW: 575,
        pcieGenMax: 5,
        pcieWidthMax: 16,
      });
      expect(gpu!.memoryUsedMiB).toBeGreaterThan(1000);
    }
  });

  it('omits placeholders, merges commas in names and sorts by index (hand-made legacy)', () => {
    const gpus = parseProbe(fixture('nvidia-smi/handmade/legacy-probe.csv'), probeFields);
    expect(gpus).toEqual([
      {
        index: 0,
        uuid: 'GPU-11111111-2222-3333-4444-555555555555',
        name: 'NVIDIA GeForce GTX 1050 Ti',
        vendor: 'nvidia',
        memoryTotalMiB: 4040,
        memoryUsedMiB: 5,
        driverVersion: '470.223.02',
        pcieGenMax: 3,
        pcieWidthMax: 16,
      },
      {
        index: 1,
        uuid: 'GPU-66666666-7777-8888-9999-000000000000',
        name: 'Quadro K2200, Inc.',
        vendor: 'nvidia',
        memoryTotalMiB: 4043,
        driverVersion: '470.223.02',
        computeCapability: '5.0',
        powerLimitW: 68,
      },
    ]);
  });

  it('works with a reduced field list and falls back to the detected driver version', () => {
    const fields = [
      { key: 'index', name: 'index' },
      { key: 'memTotal', name: 'memory.total' },
    ];
    expect(parseProbe('1, [N/A]\n0, 8192\nbad, 1\nshort\n', fields, { driverVersion: '470.1' })).toEqual([
      { index: 0, uuid: '', name: '', vendor: 'nvidia', memoryTotalMiB: 8192, driverVersion: '470.1' },
      { index: 1, uuid: '', name: '', vendor: 'nvidia', memoryTotalMiB: 0, driverVersion: '470.1' },
    ]);
    expect(parseProbe('0, 8192', fields)).toEqual([{ index: 0, uuid: '', name: '', vendor: 'nvidia', memoryTotalMiB: 8192 }]);
  });
});

describe('sample CSV', () => {
  it('parses the real snapshot and -lms stream captures (Windows + WSL)', () => {
    const win = parseSamples(fixture('nvidia-smi/win-snapshot.csv', { crlf: true }), sampleFields, 42);
    expect(win).toEqual([
      {
        t: 42,
        gpu: 0,
        utilPct: 3,
        memUsedMiB: 1800,
        memTotalMiB: 32607,
        powerW: 56.26,
        tempC: 50,
        smClockMHz: 1207,
        memClockMHz: 405,
        pcieGen: 1,
        pcieWidth: 4,
        throttle: ['reliability'],
      },
    ]);
    for (const f of ['nvidia-smi/win-stream.csv', 'nvidia-smi/wsl-stream.csv', 'nvidia-smi/wsl-snapshot.csv']) {
      const rows = lines(fixture(f)).map((l) => parseSampleRow(l, sampleFields, 1));
      expect(rows.length).toBeGreaterThan(0);
      for (const r of rows) {
        expect(r).toMatchObject({ gpu: 0, memTotalMiB: 32607, throttle: ['reliability'] });
        expect(r!.powerW).toBeGreaterThan(10);
      }
    }
  });

  it('parses the legacy alias capture (power.draw, clocks_throttle_reasons.active)', () => {
    const fields = activeFields(SAMPLE_FIELDS, {
      ...initialChoice(SAMPLE_FIELDS),
      powerInstant: null,
      throttle: 'clocks_throttle_reasons.active',
    });
    const [s] = parseSamples(fixture('nvidia-smi/win-snapshot-legacy-names.csv'), fields, 0);
    expect(s).toMatchObject({ gpu: 0, powerW: 67.52, memUsedMiB: 1862, throttle: ['reliability'] });
  });

  it('maps placeholders to null and falls back from power.draw.instant to power.draw', () => {
    const fields = activeFields(SAMPLE_FIELDS, { ...initialChoice(SAMPLE_FIELDS), powerInstant: null, throttle: 'clocks_throttle_reasons.active' });
    const [a, b] = parseSamples(fixture('nvidia-smi/handmade/legacy-sample.csv'), fields, 7);
    expect(a).toEqual({
      t: 7,
      gpu: 0,
      utilPct: 0,
      memUsedMiB: 5,
      memTotalMiB: 4040,
      powerW: null,
      tempC: 35,
      smClockMHz: 139,
      memClockMHz: 405,
      pcieGen: 1,
      pcieWidth: 16,
      throttle: [],
    });
    expect(b).toMatchObject({ gpu: 1, utilPct: null, powerW: 21.53, tempC: null, throttle: ['sw_power_cap'] });
    const [c] = parseSamples('0, 1, 2, 3, [N/A], 99.5, 4, 5, 6, 7, 8, 0x0', sampleFields, 0);
    expect(c!.powerW).toBe(99.5);
  });

  it('ignores garbage, empty, partial and non-integer-index lines', () => {
    expect(parseSampleRow('garbage line from a dying nvidia-smi', sampleFields, 0)).toBeUndefined();
    expect(parseSampleRow('1, 12, 1030', sampleFields, 0)).toBeUndefined();
    expect(parseSampleRow('x, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 0x0', sampleFields, 0)).toBeUndefined();
    expect(parseSampleRow('0.5, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 0x0', sampleFields, 0)).toBeUndefined();
    expect(parseSampleRow('-1, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 0x0', sampleFields, 0)).toBeUndefined();
    const multi = parseSamples(fixture('nvidia-smi/handmade/multi-gpu-stream.csv'), sampleFields, 0);
    expect(multi.map((s) => s.gpu)).toEqual([0, 0, 0, 1, 1]);
  });
});

describe('compute apps CSV', () => {
  it('parses the real WDDM list (used_memory [N/A]) and the empty WSL list', () => {
    const apps = parseComputeApps(fixture('nvidia-smi/win-compute-apps.csv', { crlf: true }));
    expect(apps).toHaveLength(23);
    expect(apps[1]).toEqual({ pid: 14064, processName: 'C:\\Windows\\explorer.exe', usedMiB: null });
    expect(apps.find((a) => a.pid === 20304)?.processName).toBe(
      'C:\\Program Files (x86)\\Microsoft\\EdgeWebView\\Application\\154.0.4258.48\\msedgewebview2.exe',
    );
    expect(parseComputeApps(fixture('nvidia-smi/wsl-compute-apps.csv'))).toEqual([]);
  });

  it('handles commas in paths, placeholders, two-column rows and junk (hand-made)', () => {
    expect(parseComputeApps(fixture('nvidia-smi/handmade/compute-apps-edge.csv'))).toEqual([
      { pid: 4242, processName: '/opt/llama.cpp/build/bin/llama-server', usedMiB: 18432 },
      { pid: 4242, processName: '/opt/llama.cpp/build/bin/llama-server', usedMiB: 1024 },
      { pid: 5151, processName: 'C:\\Program Files\\Acme, Inc\\LM Studio\\LM Studio.exe', usedMiB: null },
      { pid: 6161, processName: '[Insufficient Permissions]', usedMiB: null },
      { pid: 7171, processName: '/usr/bin/python3', usedMiB: 9000 },
    ]);
    expect(parseComputeApps('99, only-two-columns\n0, idle, 1')).toEqual([{ pid: 99, processName: 'only-two-columns', usedMiB: null }]);
  });
});
