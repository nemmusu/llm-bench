/**
 * Mock data for M0 screens. M1 replaces each export with the matching API route:
 *   mockSystem  → GET /api/system
 *   mockEngines → GET /api/engines
 */
import type { SystemResponse } from '../../contract/api';
import type { EngineStatus } from '../../contract/engines';
import type { GpuInfo } from '../../contract/hardware';

export const MIB = 1024 * 1024;
export const GIB = 1024 * MIB;

/** RTX 5090 board power limit, used as the power gauge maximum. */
export const POWER_LIMIT_W = 575;

export const mockGpu: GpuInfo = {
  index: 0,
  uuid: 'GPU-6c1f9a2e-41d7-8b3e-a5c0-2f9d71e4b8a1',
  name: 'NVIDIA GeForce RTX 5090',
  vendor: 'nvidia',
  memoryTotalMiB: 32607,
  memoryUsedMiB: 1638,
  driverVersion: '617.14',
  cudaVersion: '13.4',
  computeCapability: '12.0',
  powerLimitW: POWER_LIMIT_W,
  pcieGenMax: 5,
  pcieWidthMax: 16,
};

export const mockSystem: SystemResponse = {
  gpus: [mockGpu],
  os: { platform: 'win32', release: '10.0.26300', arch: 'x64', name: 'Windows 11 Pro 25H2', isWsl: false, powerPlan: 'Prestazioni elevate' },
  cpu: { model: 'AMD Ryzen 9 9950X3D', cores: 16, threads: 32 },
  ramBytes: 64 * GIB,
  hostLabel: 'WORKSTATION',
  nvidiaSmi: { found: true, path: 'C:\\Windows\\System32\\nvidia-smi.exe' },
  otherGpuUsers: [{ pid: 18244, name: 'llama-server.exe', knownLlm: true }],
  docker: { state: 'stopped', version: '29.8.0' },
  paths: {
    dataDir: 'C:\\Users\\utente\\AppData\\Roaming\\GPU Bench',
    resultsDir: 'C:\\Users\\utente\\AppData\\Roaming\\GPU Bench\\results',
    modelsDir: 'C:\\models',
    enginesDir: 'C:\\Users\\utente\\AppData\\Roaming\\GPU Bench\\engines',
  },
};

/** Size of the managed llama.cpp download (binaries + cudart) shown before installing. */
export const LLAMACPP_DOWNLOAD_BYTES = 480 * MIB;
export const LLAMACPP_BUILD = 'b11438';

export const mockEngines: EngineStatus[] = [
  { kind: 'llamacpp-native', available: false, installed: false, problems: ['ENGINE_NOT_INSTALLED'], supported: true },
  {
    kind: 'llamacpp-docker',
    available: false,
    installed: false,
    variant: 'server-cuda',
    problems: ['DOCKER_NOT_RUNNING'],
    supported: true,
  },
  { kind: 'vllm-docker', available: false, installed: false, version: 'v0.12.0', problems: ['DOCKER_NOT_RUNNING'], supported: true },
  { kind: 'vllm-native', available: false, installed: false, problems: [], supported: false },
  { kind: 'external', available: true, installed: true, problems: [], supported: true },
];
