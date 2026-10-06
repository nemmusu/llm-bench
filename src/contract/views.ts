/**
 * Response shapes of the feature routes, for the renderer.
 *
 * The renderer may import only from src/contract. These types are owned by the core modules that
 * produce them, so they are re-exported here *type-only*: one source of truth, no runtime coupling
 * (the renderer still talks to the core exclusively over HTTP). dependency-cruiser enforces that
 * this file is the only contract file touching the core, and only with type imports.
 */
export type {
  CheckAction,
  CheckActionKind,
  CheckId,
  CheckItem,
  CheckParams,
  CheckState,
  SystemCheckReport,
} from '../core/setup/system-check';
export type { DriverAction, DriverCheckResult, DriverLink, DriverState, LinuxDriverGuidance } from '../core/setup/driver';
export type { SetupJob, SetupJobKind } from '../core/setup/service';
export type { DockerInstallPlan, DockerInstallResult } from '../core/setup/docker-installer';
export type { UvInstalled, UvPlan } from '../core/setup/uv';
export type { DockerStatusDetail, GpuCheckResult } from '../core/docker/environment';
export type { HubTag } from '../core/docker/hub';
export type { CuratedResponse, HubFitResult } from '../core/models/service';
export type { QuantChoice } from '../core/models/fit';
export type { CuratedList, CuratedModel } from '../core/models/curated';
export type { RemoteGgufFacts } from '../core/models/hub';
export type { AttentionGroup, KvLayout, ModelFactsEx } from '../core/models/types';
export type { InstalledBuild } from '../core/engines/llamacpp-native/install';
export type { ColdCacheStatus } from '../core/cache/routes';
