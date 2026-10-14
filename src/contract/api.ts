import { z } from 'zod';
import { dockerStateSchema } from './docker';
import { engineConfigSchema, engineKindSchema, engineStatusSchema, launchParamsSchema } from './engines';
import { currentStepSchema, livePointSchema, liveSpillSchema, loadProgressSchema, runLaunchSchema, runPhaseSchema } from './events';
import { gpuInfoSchema, osInfoSchema } from './hardware';
import { fitEstimateSchema, hubFileSchema, hubModelSchema, localModelSchema } from './models';
import { ninferBuildChoiceSchema } from './ninfer';
import { appliedRecipeSchema, MAX_RECIPE_CONTEXT, recipeChoiceSchema } from './recipes';
import { profileSchema, scenarioSchema, TUNE_MAX_USERS, tuneBudgetSchema, tuneGoalSchema, tuneKvTypeSchema, tuningSchema } from './results';
import { serverNetworkSchema, serverPortSchema } from './servers';

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
 *   GET    /api/models/search?q=&format=&sort=&author=&minParamsB=&maxParamsB=&onlyFits=&cursor= -> HubSearchPage
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
 *   GET    /api/configs?gpu=&model=&engine=&minContext= -> ConfigsResponse (results by configuration, contract/configs.ts)
 *   GET    /api/servers                      -> ServerInfo[] (the Server page, the sidebar, the tray)
 *   POST   /api/servers/plan                 (StartServerRequest) -> ServerPlan (preview: command, downloads, context, fit, port)
 *   POST   /api/servers                      (StartServerRequest) -> ServerInfo (when ready)
 *   DELETE /api/servers/:id                  -> { ok: true }
 *   (presets, API key, restart, log and notices: contract/servers.ts)
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
    state: dockerStateSchema,
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
  /** Profile "tune" ("Trova le impostazioni migliori"): time budget and the optional "fedeltà" check. */
  tune: z
    .object({
      budget: tuneBudgetSchema.default('fast'),
      fidelity: z.boolean().default(false),
      /** Absent = 'single' ("Un utente, contesto massimo"). */
      goal: tuneGoalSchema.optional(),
      /** Goal 'multi': users at once (absent = TUNE_MULTI_DEFAULTS.users = 4). */
      users: z.number().int().min(2).max(TUNE_MAX_USERS).optional(),
      /** Goal 'multi': context each user needs, tokens (absent = TUNE_MULTI_DEFAULTS.perUserContext = 8192). */
      perUserContext: z.number().int().min(1024).max(1_048_576).optional(),
      /**
       * Budget 'recheck': the tune run to re-check. Absent = the latest completed tune of this model on
       * this GPU with this engine kind and the same goal (RunPlan.previousTune). None → VALIDATION
       * (reason 'recheck_nothing').
       */
      recheckOf: z.string().optional(),
      /**
       * "Contesto oltre il limite del modello (YaRN)": the capacity search may go up to this context
       * (tokens, above the trained one), every launch beyond the trained context with YaRN at factor
       * context / trained. Absent = up to the trained context (or a recipe's RoPE scaling).
       */
      yarnTarget: z.number().int().min(1024).max(MAX_RECIPE_CONTEXT).optional(),
    })
    .optional(),
  /**
   * "Comandi per questo modello" (contract/recipes.ts): absent = the model's recipe, if it has one;
   * { use: false } = without it; { id } = that recipe; { inline } = an unsaved one (live preview).
   */
  recipe: recipeChoiceSchema.optional(),
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
  /**
   * Expected duration. Profile "tune": the search's own estimate for this model on this PC (predicted
   * largest contexts, expected prompt reading speed, launches); its time limit is this times a margin.
   */
  estimatedSeconds: z.number(),
  /** Profile "tune": the estimate of each budget for this model ("Veloce · circa 20 min per questo modello"). */
  tuneSeconds: z.object({ fast: z.number().min(0), thorough: z.number().min(0) }).optional(),
  /**
   * VRAM verdict. When a llama.cpp launch with every layer on the GPU does not fit, `fit.fixes` says
   * what would, and `warnings` say what will really happen: 'spill_risk' (Windows: the rest goes to
   * shared system memory, ~10–15× slower) or 'oom_risk' (Linux: out of memory).
   */
  fit: fitEstimateSchema.optional(),
  warnings: z.array(z.object({ code: z.string(), params: z.record(z.string(), z.unknown()).optional() })),
  /**
   * Profile "tune": the latest completed tune of this model on this GPU with this engine kind and the
   * same goal (users and context per user included for 'multi'). `sameBuild` false = it ran with
   * another engine build or image: offer "Ricontrollo rapido" (tune.budget 'recheck').
   */
  previousTune: z
    .object({
      runId: z.string(),
      createdAt: z.string(),
      budget: tuneBudgetSchema,
      /** Its engine build / image ("b10997"); absent when unknown. */
      build: z.string().optional(),
      /** The build / image this run would use; absent when unknown (not installed yet…). */
      currentBuild: z.string().optional(),
      sameBuild: z.boolean(),
    })
    .optional(),
  /** The model's command recipe this run uses: what it set, what the user's settings replaced, what did not apply. */
  recipe: appliedRecipeSchema.optional(),
  /**
   * A .ninfer model only NInfer-all reads (contract/ninfer.ts ninferBuildFor): NInfer-all runs it, whatever
   * NInfer build was chosen. `ready` false: it is not built yet (the start flow builds it first; POST
   * /api/runs fails with ENGINE_NOT_INSTALLED, reason 'ninfer_all_missing').
   */
  ninferBuild: ninferBuildChoiceSchema.optional(),
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
  /** Profile "tune": the search so far (attempts, combinations measured), for a reopened live screen. */
  tuning: tuningSchema.optional(),
  /** The engine instance in use (last `run.launch`). */
  launch: runLaunchSchema.optional(),
  /** The request in flight (last `run.step`). */
  current: currentStepSchema.optional(),
  /** Every measurement so far (latest `run.point` per key), in arrival order. */
  points: z.array(livePointSchema).default([]),
  /** The engine start in progress (last `run.load`); absent when no engine is starting. */
  loading: loadProgressSchema.optional(),
  /** Seconds the core expects are left (last `run.phase` that said). */
  remainingSeconds: z.number().min(0).optional(),
  /** The engine spilled to shared system memory (last `run.spill`). */
  spill: liveSpillSchema.optional(),
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
  /** A local model (id) the files belong with: they go into its repo folder, next to it (an mmproj, an update). */
  into: z.string().optional(),
});
export type DownloadRequest = z.infer<typeof downloadRequestSchema>;

/** POST /api/models/updates/check: one repo (the model page), or every downloaded repo. */
export const checkUpdatesRequestSchema = z.object({ repo: z.string().optional() });
export type CheckUpdatesRequest = z.infer<typeof checkUpdatesRequestSchema>;

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

/**
 * A server outside a benchmark. `params` are what the user chose: whatever is left unset gets the
 * recommended value for this card (see ServerPlan.params).
 */
export const startServerRequestSchema = startRunRequestSchema.pick({ engine: true, model: true, params: true, recipe: true }).extend({
  /** The port other programs use. Absent = the first free one from 8080 (ServerPlan.port says which). */
  port: serverPortSchema.optional(),
  /**
   * 'lan': reachable from other devices on the local network (bound to 0.0.0.0), only with LLM Bench's
   * API key (--api-key). Absent = 'local' (127.0.0.1 only).
   */
  network: serverNetworkSchema.optional(),
  /** Started from this saved preset: listed with its name, and "Riavvia" keeps it. */
  presetId: z.string().optional(),
});
export type StartServerRequest = z.infer<typeof startServerRequestSchema>;

/** Preview of "Avvia solo il server": what will run, what is fetched first, and how much text it takes. */
export const serverPlanSchema = z.object({
  /** The exact command that will be executed. */
  command: runPlanSchema.shape.command,
  /** Installs and downloads to do first, as in RunPlan. POST /api/servers needs them done. */
  needs: runPlanSchema.shape.needs,
  pending: runPlanSchema.shape.pending,
  /** The launch parameters that will be used: the request's, plus the ones chosen for this card. */
  params: launchParamsSchema,
  /** Tokens the server can take at once (prompt + answer): llama.cpp ctx-size, vLLM max-model-len. */
  contextSize: z.number().int().optional(),
  /**
   * The context and KV cache came from the latest completed "Trova le impostazioni migliori" run of
   * this model on this GPU (its recommended combination), instead of the VRAM estimate.
   */
  tuned: z
    .object({
      runId: z.string(),
      createdAt: z.string(),
      contextSize: z.number().int(),
      kvCacheType: tuneKvTypeSchema,
      /** The tune's goal (absent = 'single') and, for 'multi', its users: "-np 4, 8K a testa". */
      goal: tuneGoalSchema.optional(),
      users: z.number().int().optional(),
      /**
       * The tune ran with another engine build / image than the one this server will use ("dal test fatto
       * con b10997; ora usi b11438: fai un ricontrollo rapido"). A tune with the current build is always
       * preferred; this is set only when none exists.
       */
      otherBuild: z.object({ build: z.string(), current: z.string().optional() }).optional(),
    })
    .optional(),
  fit: fitEstimateSchema.optional(),
  warnings: runPlanSchema.shape.warnings,
  /** The model's command recipe this server uses (as in RunPlan.recipe). */
  recipe: appliedRecipeSchema.optional(),
  /** NInfer-all runs this .ninfer model (as in RunPlan.ninferBuild). */
  ninferBuild: ninferBuildChoiceSchema.optional(),
  /** The port it will listen on: the request's, else the first free one from 8080. */
  port: z.number().int(),
  network: serverNetworkSchema,
  /** 'lan': the addresses other devices will use (…/v1), one per network card of this PC. */
  lanUrls: z.array(z.string()).optional(),
});
export type ServerPlan = z.infer<typeof serverPlanSchema>;

/** An engine started by LLM Bench outside a benchmark, kept running until the user stops it. */
export const serverInfoSchema = z.object({
  id: z.string(),
  baseUrl: z.string(),
  /** OpenAI-compatible base for other programs (…/v1). */
  openaiUrl: z.string(),
  modelName: z.string(),
  engineLabel: z.string(),
  startedAt: z.string(),
  command: z.object({ argv: z.array(z.string()), powershell: z.string(), bash: z.string() }),
  /** Tokens the server takes at once (as in ServerPlan.contextSize), when known. */
  contextSize: z.number().int().optional(),
  /**
   * Present while the engine is still starting (GET /api/servers lists a server as soon as it is
   * launched): what it is doing now. Absent once it answers.
   */
  loading: loadProgressSchema.optional(),
  /** The model as the library names it ("Qwen3-8B-Q4_K_M"); `modelName` is what the API answers to. */
  modelLabel: z.string(),
  engineKind: engineKindSchema,
  /** The launch params it runs with (the request's plus the ones chosen for this card): its configuration in words. */
  params: launchParamsSchema,
  /** The model's layer count, for the configuration label (-ngl at or above it is "all on the GPU"). */
  blockCount: z.number().int().optional(),
  port: z.number().int(),
  network: serverNetworkSchema,
  /** 'lan': the addresses other devices use (…/v1), one per network card of this PC. */
  lanUrls: z.array(z.string()).default([]),
  /** The request it was started with, its port included: "Riavvia" and "Salva come preset" reuse it. */
  request: startServerRequestSchema,
  presetId: z.string().optional(),
  presetName: z.string().optional(),
  /** VRAM the server took when it started (GPU memory in use once ready, minus before the start), MiB. */
  vramMiB: z.number().optional(),
});
export type ServerInfo = z.infer<typeof serverInfoSchema>;
