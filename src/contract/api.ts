import { z } from 'zod';
import { engineConfigSchema, engineStatusSchema, launchParamsSchema } from './engines';
import { runPhaseSchema } from './events';
import { gpuInfoSchema, osInfoSchema } from './hardware';
import { fitEstimateSchema, hubFileSchema, hubModelSchema, localModelSchema } from './models';
import { profileSchema, scenarioSchema } from './results';

/**
 * HTTP API between renderer and core. All routes live under /api, need
 * `Authorization: Bearer <session token>`, and return JSON. Errors return
 * `{ error: AppErrorData }` with a 4xx/5xx status.
 *
 *   GET    /api/health                       -> HealthResponse
 *   GET    /api/system                       -> SystemResponse
 *   GET    /api/settings                     -> Settings
 *   PUT    /api/settings                     (Partial<Settings>) -> Settings
 *   GET    /api/events                       -> text/event-stream of ServerEvent
 *   GET    /api/engines                      -> EngineStatus[]
 *   POST   /api/engines/:kind/install        (InstallEngineRequest) -> { ok: true } (any kind with an installer)
 *   GET    /api/engines/llamacpp/releases    -> LlamaRelease[]
 *   GET    /api/models/local                 -> LocalModel[]
 *   POST   /api/models/rescan                -> LocalModel[]
 *   GET    /api/models/search?q=&format=&sort= -> HubModel[]
 *   GET    /api/models/hub/:owner/:name      -> HubRepoInfo (HubModel + sha, private)
 *   GET    /api/models/hub/:owner/:name/files -> HubFile[]
 *   POST   /api/models/fit                   (FitRequest) -> FitEstimate
 *   GET    /api/downloads                    -> DownloadJob[]
 *   POST   /api/downloads                    (DownloadRequest) -> DownloadJob
 *   POST   /api/downloads/:id/(pause|resume|cancel) -> DownloadJob
 *   GET    /api/runs?model=&gpu=             -> RunSummary[]
 *   GET    /api/runs/:id                     -> RunResult
 *   DELETE /api/runs/:id                     -> { ok: true }
 *   POST   /api/runs                         (StartRunRequest) -> { runId }
 *   POST   /api/runs/:id/cancel              -> { ok: true }
 *   POST   /api/runs/plan                    (StartRunRequest) -> RunPlan (preview: command, downloads, duration)
 *   GET    /api/runs/active                  -> ActiveRunResponse
 *   GET    /api/runs/tried?weakKey=&sha256=  -> RunSummary[] (results for a model, this GPU first)
 *   GET    /api/servers                      -> ServerInfo[] ("Avvia solo il server così")
 *   POST   /api/servers                      (StartServerRequest) -> ServerInfo (when ready)
 *   DELETE /api/servers/:id                  -> { ok: true }
 *
 * Feature routes (setup, docker, cache, models extras) document themselves next to their handlers;
 * their response types are re-exported for the renderer from contract/views.ts.
 */

export const healthResponseSchema = z.object({ ok: z.literal(true), version: z.string(), pid: z.number() });
export type HealthResponse = z.infer<typeof healthResponseSchema>;

export const systemResponseSchema = z.object({
  gpus: z.array(gpuInfoSchema),
  os: osInfoSchema,
  cpu: z.object({ model: z.string(), cores: z.number(), threads: z.number() }),
  ramBytes: z.number(),
  hostLabel: z.string(),
  /** This PC's stable id (same as RunSummary.hostId of runs made here): "this PC" vs other PCs. */
  hostId: z.string(),
  nvidiaSmi: z.object({ found: z.boolean(), path: z.string().optional() }),
  /** Known LLM servers using the GPU right now (never ours). */
  otherGpuUsers: z.array(
    z.object({
      pid: z.number(),
      name: z.string(),
      knownLlm: z.boolean(),
      /** Dedicated VRAM held by the process, when the OS can tell (Windows GPU counters, Linux nvidia-smi). */
      memMiB: z.number().optional(),
      /** 'vm' = WSL / Hyper-V / Docker Desktop VM (vmwp, vmmem): its GPU use belongs to programs inside it. */
      kind: z.enum(['llm', 'vm', 'system', 'app']).optional(),
    }),
  ),
  docker: z.object({
    state: z.enum(['not-installed', 'stopped', 'starting', 'running', 'no-permission', 'no-gpu', 'unsupported', 'unknown']),
    version: z.string().optional(),
  }),
  paths: z.object({ dataDir: z.string(), resultsDir: z.string(), modelsDir: z.string(), enginesDir: z.string() }),
});
export type SystemResponse = z.infer<typeof systemResponseSchema>;

export const startRunRequestSchema = z.object({
  engine: engineConfigSchema,
  /**
   * Local model id (from /api/models/local), HF repo for vLLM, HF repo + GGUF `file` for llama.cpp
   * (the library copy when downloaded; plan previews also work before the download), or the model
   * name for external endpoints.
   */
  model: z.object({
    localId: z.string().optional(),
    repo: z.string().optional(),
    /** Path of the GGUF inside `repo` (first shard of a split model), as in HubFile.path / CuratedModel.file. */
    file: z.string().optional(),
    revision: z.string().optional(),
    name: z.string().optional(),
  }),
  profile: profileSchema,
  /** Required when profile is "custom". */
  scenario: scenarioSchema.optional(),
  params: launchParamsSchema.optional(),
  /** Proceed even if other LLM servers hold VRAM. */
  allowSharedGpu: z.boolean().default(false),
  note: z.string().optional(),
});
export type StartRunRequest = z.infer<typeof startRunRequestSchema>;

export const runPlanSchema = z.object({
  scenario: scenarioSchema,
  /** The exact command that will be executed, ready to show in "Anteprima comando". */
  command: z.object({ argv: z.array(z.string()), powershell: z.string(), bash: z.string() }),
  needs: z.array(
    z.object({ kind: z.enum(['engine', 'model', 'image']), label: z.string(), bytes: z.number().optional() }),
  ),
  /**
   * Parts of `command` that do not exist yet: the llama.cpp executable is where the install will put
   * it ('engine'), the GGUF where the download will put it ('model'). Absent when nothing is missing.
   * A run cannot start until `needs` are done (POST /api/runs fails with ENGINE_NOT_INSTALLED / MODEL_NOT_FOUND).
   */
  pending: z.array(z.enum(['engine', 'model'])).optional(),
  estimatedSeconds: z.number(),
  fit: fitEstimateSchema.optional(),
  warnings: z.array(z.object({ code: z.string(), params: z.record(z.string(), z.unknown()).optional() })),
});
export type RunPlan = z.infer<typeof runPlanSchema>;

/** The run in progress (GET /api/runs/active), so the live screen can be reopened at any time. */
export const activeRunSchema = z.object({
  runId: z.string(),
  phase: runPhaseSchema,
  /** 0..1 progress inside the whole run. */
  progress: z.number(),
  /** ISO time the run was started. */
  startedAt: z.string(),
  profile: profileSchema,
  /** Expected duration in seconds (as in the plan; past runs of this model on this PC refine it). */
  estimatedSeconds: z.number(),
  modelName: z.string(),
  /** "llama.cpp b10997 (cuda-13.4)", the same label as RunSummary.engineLabel. */
  engineLabel: z.string(),
  /** The scenario being run, already fitted to the engine and model. */
  scenario: scenarioSchema,
});
export type ActiveRun = z.infer<typeof activeRunSchema>;
export const activeRunResponseSchema = z.object({ active: activeRunSchema.nullable() });
export type ActiveRunResponse = z.infer<typeof activeRunResponseSchema>;

export const fitRequestSchema = z.object({
  localId: z.string().optional(),
  repo: z.string().optional(),
  file: z.string().optional(),
  engine: engineConfigSchema.shape.kind,
  params: launchParamsSchema.optional(),
});
export type FitRequest = z.infer<typeof fitRequestSchema>;

export const downloadRequestSchema = z.object({
  repo: z.string(),
  revision: z.string().default('main'),
  /** Files to fetch (all shards of a split GGUF; whole repo minus extras for vLLM). */
  files: z.array(z.string()).min(1),
  label: z.string().optional(),
});
export type DownloadRequest = z.infer<typeof downloadRequestSchema>;

export const installEngineRequestSchema = z.object({
  /** llama.cpp native: release tag (default the newest with an asset for this PC). */
  build: z.string().optional(),
  /** llama.cpp native: asset variant ("cuda-13.4", "vulkan", "cpu"). */
  variant: z.string().optional(),
  /** Docker engines: image to pull (default the saved or the recommended one). */
  image: z.string().optional(),
});
export type InstallEngineRequest = z.infer<typeof installEngineRequestSchema>;

export const llamaReleaseSchema = z.object({
  tag: z.string(),
  publishedAt: z.string(),
  assets: z.array(z.object({ name: z.string(), url: z.string(), size: z.number(), digest: z.string().optional() })),
});
export type LlamaRelease = z.infer<typeof llamaReleaseSchema>;

export const apiSchemas = {
  engineStatus: engineStatusSchema,
  localModel: localModelSchema,
  hubModel: hubModelSchema,
  hubFile: hubFileSchema,
};

export const startServerRequestSchema = startRunRequestSchema.pick({ engine: true, model: true, params: true });
export type StartServerRequest = z.infer<typeof startServerRequestSchema>;

/** An engine started by GPU Bench outside a benchmark, kept running until the user stops it. */
export const serverInfoSchema = z.object({
  id: z.string(),
  baseUrl: z.string(),
  /** OpenAI-compatible base for other programs (…/v1). */
  openaiUrl: z.string(),
  modelName: z.string(),
  engineLabel: z.string(),
  startedAt: z.string(),
  command: z.object({ argv: z.array(z.string()), powershell: z.string(), bash: z.string() }),
});
export type ServerInfo = z.infer<typeof serverInfoSchema>;
