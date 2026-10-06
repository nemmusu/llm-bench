import { describe, expect, it } from 'vitest';
import type { GpuInfo } from '../../../../src/contract/hardware';
import {
  DRIVER_REQUIREMENTS,
  NVIDIA_APP_PAGE,
  NVIDIA_DRIVER_PAGE,
  architectureOf,
  compareVersions,
  driverCheck,
  driverRequirementsSchema,
  linuxDriverGuidance,
  maxCudaForDriver,
  minDriverForCuda,
  parseDriverVersion,
} from '../../../../src/core/setup/driver';
import { parseOsRelease } from '../../../../src/core/setup/os-release';
import requirements from '../../../../resources/driver-requirements.json';

const RTX5090: Pick<GpuInfo, 'name' | 'vendor' | 'computeCapability'> = { name: 'NVIDIA GeForce RTX 5090', vendor: 'nvidia', computeCapability: '12.0' };
const RTX3070: Pick<GpuInfo, 'name' | 'vendor' | 'computeCapability'> = { name: 'NVIDIA GeForce RTX 3070', vendor: 'nvidia' };
const UBUNTU = parseOsRelease('ID=ubuntu\nVERSION_CODENAME=noble\nUBUNTU_CODENAME=noble\n');

describe('driver requirements table', () => {
  it('is valid, cites its sources and covers every CUDA build llama.cpp ships', () => {
    expect(driverRequirementsSchema.parse(requirements)).toEqual(DRIVER_REQUIREMENTS);
    expect(requirements.sources.length).toBeGreaterThan(0);
    for (const row of requirements.cudaDrivers) expect(requirements.sources.map((s) => s.id)).toContain(row.source);
    expect(minDriverForCuda('12.4', 'win32')).toBe('551.61');
    expect(minDriverForCuda('12.8', 'linux')).toBe('570.26');
    expect(minDriverForCuda('13.4', 'win32')).toBe('615.00');
    expect(NVIDIA_DRIVER_PAGE).toMatch(/^https:\/\/www\.nvidia\.com\//);
    expect(NVIDIA_APP_PAGE).toMatch(/^https:\/\/www\.nvidia\.com\//);
  });

  it('rounds an unknown CUDA minor up to the next listed one', () => {
    expect(minDriverForCuda('12.7', 'linux')).toBe('570.26');
    expect(minDriverForCuda('14.0', 'linux')).toBeUndefined();
    expect(minDriverForCuda('n/a', 'linux')).toBeUndefined();
  });
});

describe('versions', () => {
  it('parses driver versions', () => {
    expect(parseDriverVersion('617.14')).toEqual([617, 14]);
    expect(parseDriverVersion(' 570.86.16 ')).toEqual([570, 86, 16]);
    expect(parseDriverVersion('R570')).toBeUndefined();
    expect(parseDriverVersion(undefined)).toBeUndefined();
  });

  it('compares segment by segment', () => {
    expect(compareVersions([615], [615, 0])).toBe(0);
    expect(compareVersions([615, 0], [615])).toBe(0);
    expect(compareVersions([570, 86, 16], [570, 124])).toBeLessThan(0);
    expect(compareVersions([617, 14], [615])).toBeGreaterThan(0);
  });
});

describe('maxCudaForDriver', () => {
  it('maps drivers to the highest CUDA they support', () => {
    expect(maxCudaForDriver('617.14', 'win32')).toBe('13.4');
    expect(maxCudaForDriver('576.57', 'win32')).toBe('12.9');
    expect(maxCudaForDriver('570.86.16', 'linux')).toBe('12.8');
    expect(maxCudaForDriver('610.43.02', 'linux')).toBe('13.3');
    expect(maxCudaForDriver('610.10', 'linux')).toBe('13.2');
    expect(maxCudaForDriver('470.00', 'linux')).toBeUndefined();
  });

  it('uses Windows numbering under WSL and gives up elsewhere', () => {
    expect(maxCudaForDriver('572.16', 'linux', { isWsl: true })).toBe('12.8');
    expect(maxCudaForDriver('572.16', 'darwin')).toBeUndefined();
    expect(maxCudaForDriver('bogus', 'linux')).toBeUndefined();
  });
});

describe('architectureOf', () => {
  it('matches by compute capability, else by name', () => {
    expect(architectureOf(RTX5090)?.id).toBe('blackwell-rtx');
    expect(architectureOf({ name: 'NVIDIA GeForce RTX 5070 Ti' })?.id).toBe('blackwell-rtx');
    expect(architectureOf({ name: 'NVIDIA B200', computeCapability: '10.0' })?.id).toBe('blackwell-datacenter');
    expect(architectureOf({ name: 'NVIDIA GeForce RTX 5090', computeCapability: '8.9' })).toBeUndefined();
    expect(architectureOf(RTX3070)).toBeUndefined();
  });
});

describe('linuxDriverGuidance', () => {
  it('picks the distro guide', () => {
    expect(linuxDriverGuidance(UBUNTU).code).toBe('ubuntu-drivers');
    expect(linuxDriverGuidance(parseOsRelease('ID=linuxmint\nID_LIKE="ubuntu debian"')).code).toBe('ubuntu-drivers');
    expect(linuxDriverGuidance(parseOsRelease('ID=debian')).code).toBe('debian-nonfree');
    expect(linuxDriverGuidance(parseOsRelease('ID=kali\nID_LIKE=debian')).code).toBe('debian-nonfree');
    expect(linuxDriverGuidance(parseOsRelease('ID=fedora')).code).toBe('rpmfusion');
    expect(linuxDriverGuidance(parseOsRelease('ID=nobara\nID_LIKE="fedora"')).code).toBe('rpmfusion');
    expect(linuxDriverGuidance(parseOsRelease('ID=arch'))).toEqual({ code: 'nvidia-docs', url: DRIVER_REQUIREMENTS.links.nvidiaLinux });
    expect(linuxDriverGuidance(undefined).code).toBe('nvidia-docs');
  });
});

describe('driverCheck', () => {
  it('accepts this PC: RTX 5090, driver 617.14, CUDA 13.4', () => {
    const r = driverCheck({ gpus: [RTX5090], driverVersion: '617.14', cudaVersion: '13.4', platform: 'win32' });
    expect(r).toMatchObject({
      state: 'ok',
      driverVersion: '617.14',
      cudaVersion: '13.4',
      cudaSource: 'nvidia-smi',
      minRequired: '572.16',
      reason: 'architecture',
      architecture: 'blackwell-rtx',
      recommendedAction: 'none',
    });
    expect(r.links.map((l) => l.kind)).toEqual(['driver-page', 'nvidia-app']);
  });

  it('flags a driver too old for Blackwell even when it suits llama.cpp', () => {
    const r = driverCheck({ gpus: [RTX5090], driverVersion: '566.36', platform: 'win32' });
    expect(r).toMatchObject({ state: 'too-old', minRequired: '572.16', reason: 'architecture', recommendedAction: 'open-driver-page', cudaVersion: '12.6', cudaSource: 'table' });
  });

  it('uses the app minimum for older GPUs and ignores non-NVIDIA adapters', () => {
    const other = { name: 'Intel(R) UHD Graphics', vendor: 'other' as const };
    expect(driverCheck({ gpus: [other, RTX3070], driverVersion: '551.61', platform: 'win32' })).toMatchObject({ state: 'ok', minRequired: '551.61', reason: 'app-minimum' });
    expect(driverCheck({ gpus: [RTX3070], driverVersion: '537.13', platform: 'win32' })).toMatchObject({ state: 'too-old', minRequired: '551.61' });
    expect(driverCheck({ gpus: [RTX3070], driverVersion: '560.35.03', platform: 'linux', osRelease: UBUNTU })).toMatchObject({
      state: 'too-old',
      minRequired: '570.26',
      recommendedAction: 'linux-driver-guide',
      linuxGuidance: 'ubuntu-drivers',
    });
  });

  it('keeps the first architecture when a later GPU does not raise the minimum', () => {
    const b200 = { name: 'NVIDIA B200', vendor: 'nvidia' as const, computeCapability: '10.0' };
    const r = driverCheck({ gpus: [RTX5090, b200], driverVersion: '580.65.06', platform: 'linux' });
    expect(r).toMatchObject({ state: 'ok', architecture: 'blackwell-rtx', minRequired: '570.86.16', linuxGuidance: 'nvidia-docs' });
    expect(r.links).toEqual([{ kind: 'linux-guide', url: DRIVER_REQUIREMENTS.links.nvidiaLinux }]);
  });

  it('reports a missing driver with the right fix per OS', () => {
    expect(driverCheck({ gpus: [], platform: 'win32' })).toMatchObject({ state: 'missing', recommendedAction: 'open-driver-page', minRequired: '551.61' });
    expect(driverCheck({ gpus: [], platform: 'linux', driverVersion: 'N/A', osRelease: UBUNTU })).toMatchObject({
      state: 'missing',
      recommendedAction: 'linux-driver-guide',
      linuxGuidance: 'ubuntu-drivers',
    });
    // WSL: the Windows driver is the one to update.
    expect(driverCheck({ gpus: [], platform: 'linux', isWsl: true })).toMatchObject({ state: 'missing', recommendedAction: 'open-driver-page', minRequired: '570.65' });
    expect(driverCheck({ gpus: [], platform: 'darwin', driverVersion: '1.0' })).toEqual({ state: 'missing', recommendedAction: 'none', links: [] });
  });

  it('derives CUDA from the table when nvidia-smi does not say, or says nonsense', () => {
    expect(driverCheck({ gpus: [], driverVersion: '617.14', cudaVersion: 'N/A', platform: 'win32' })).toMatchObject({ cudaVersion: '13.4', cudaSource: 'table' });
    const old = driverCheck({ gpus: [], driverVersion: '470.10', platform: 'linux' });
    expect(old.state).toBe('too-old');
    expect(old.cudaVersion).toBeUndefined();
  });
});
