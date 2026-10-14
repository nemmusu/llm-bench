/**
 * Docker as LLM Bench sees it, and what happens when Docker Desktop stops answering ("Docker non
 * risponde"): the one-click restart, why it got stuck (read from Docker Desktop's own logs and
 * settings, never changed), and our servers it took down.
 *
 *   GET    /api/docker/status?probe=1  -> DockerStatusDetail after a real check (also asks the engine itself, not only its cache)
 *   POST   /api/docker/restart         ({ deep? }) -> { ok: true } at once; progress as 'engine.install' events
 *                                        { kind: 'docker-restart', stage: DockerRestartStage, step, steps, bytesDone: elapsed ms,
 *                                        state?, slow?, error?, result?: DockerRestartResult }
 *   GET    /api/docker/diagnosis       -> DockerDiagnosis
 *   POST   /api/docker/open            -> { ok: true } brings up Docker Desktop's window (its settings are there)
 *   GET    /api/docker/recovery        -> DockerRecovery
 *   POST   /api/docker/recovery        -> { ok: true } starts those servers again (progress: 'docker-restart' events, stage 'servers')
 *   DELETE /api/docker/recovery        -> { ok: true } forgets them
 *
 * The rest of the Docker routes (status, start, gpu-check, pull, cleanup) are in core/docker/routes.ts.
 */
import { z } from 'zod';

/**
 * An image of one repository on this Docker (GET /api/docker/images?repo=vllm/vllm-openai): its tags and
 * digests in that repository, so a Docker Hub tag is "on the PC" when its name is among `tags` or one of
 * its digests (the multi-platform index or a platform's manifest) is among `digests` or is the `id` (the
 * containerd image store names images by their index digest). `running`: a running container uses it.
 * POST /api/docker/images/remove ({ image }) -> { ok: true } (DOCKER_IMAGE_IN_USE while one does).
 */
export const localImageSchema = z.object({
  id: z.string(),
  tags: z.array(z.string()),
  digests: z.array(z.string()),
  sizeBytes: z.number(),
  running: z.boolean(),
});
export type LocalImage = z.infer<typeof localImageSchema>;
export const removeImageRequestSchema = z.object({ image: z.string().min(1) });

/**
 * 'not-responding': Docker Desktop is there, but its engine does not answer (stuck starting or
 * stopping, calls that time out): only a restart brings it back ("Riavvia Docker").
 */
export const DOCKER_STATES = ['not-installed', 'stopped', 'starting', 'running', 'not-responding', 'no-permission', 'no-gpu', 'unsupported', 'unknown'] as const;
export const dockerStateSchema = z.enum(DOCKER_STATES);
export type DockerState = z.infer<typeof dockerStateSchema>;

/**
 * Why Docker counts as "not responding":
 * - 'version-timeout': `docker version` did not answer, twice;
 * - 'desktop-stuck': Docker Desktop says it is stopping for too long, or does not answer itself;
 * - 'starting-too-long': it has been starting for minutes;
 * - 'start-timeout': a start we asked for never finished;
 * - 'calls-failing': real calls (starting a container, listing them) time out.
 */
export const dockerHangReasonSchema = z.enum(['version-timeout', 'desktop-stuck', 'starting-too-long', 'start-timeout', 'calls-failing']);
export type DockerHangReason = z.infer<typeof dockerHangReasonSchema>;

export const dockerRestartRequestSchema = z.object({
  /**
   * The last resort, only after the user's click: also stops Docker's own WSL machine
   * (`wsl --terminate docker-desktop`; the user's other WSL distributions are never touched).
   */
  deep: z.boolean().default(false),
});
export type DockerRestartRequest = z.input<typeof dockerRestartRequestSchema>;

/**
 * The steps of "Riavvia Docker", in order; each one runs only when the one before did not bring
 * Docker back: Docker Desktop's own restart, a forced stop and a start, then (deep) its WSL machine.
 * 'servers': our servers that were running are started again. 'running' and 'error' end it.
 */
export const DOCKER_RESTART_STEPS = ['restart', 'force-stop', 'wsl-terminate', 'start', 'servers'] as const;
export const dockerRestartStepSchema = z.enum(DOCKER_RESTART_STEPS);
export type DockerRestartStep = z.infer<typeof dockerRestartStepSchema>;
export const dockerRestartStageSchema = z.enum([...DOCKER_RESTART_STEPS, 'running', 'error']);
export type DockerRestartStage = z.infer<typeof dockerRestartStageSchema>;

/** What the restart did with our servers (the 'running' event's `result`). */
export const dockerRestartResultSchema = z.object({
  /** Names of the servers started again. */
  restored: z.array(z.string()),
  /** Names of the servers that did not start again (each also a notice on the Server page). */
  failed: z.array(z.string()),
});
export type DockerRestartResult = z.infer<typeof dockerRestartResultSchema>;

/**
 * The likely cause, from Docker Desktop's own log:
 * - 'resource-saver': its "Resource Saver" stopped the engine after a few idle minutes and the stop never finished;
 * - 'stuck-stopping': the engine stopped for another reason and the stop never finished;
 * - 'not-answering': the engine is up but does not answer;
 * - 'unknown': nothing in the logs says why.
 */
export const dockerCauseSchema = z.enum(['resource-saver', 'stuck-stopping', 'not-answering', 'unknown']);
export type DockerCause = z.infer<typeof dockerCauseSchema>;

export const dockerDiagnosisSchema = z.object({
  cause: dockerCauseSchema,
  /**
   * Docker Desktop → Settings → Resources → Advanced → Resource Saver, as Docker Desktop saved it
   * (absent from its settings = Docker's default: on, after 300 s). Undefined where there is no Docker Desktop.
   */
  resourceSaver: z.object({ enabled: z.boolean(), timeoutSeconds: z.number() }).optional(),
  /** When the engine got stuck (Docker Desktop's log), ISO. */
  since: z.string().optional(),
  /** The lines of Docker Desktop's log that show it (the expert "Dettagli"). */
  evidence: z.array(z.string()),
});
export type DockerDiagnosis = z.infer<typeof dockerDiagnosisSchema>;

/** One of our Docker servers that stopped because Docker went away. */
export const dockerLostServerSchema = z.object({
  id: z.string(),
  /** The preset's name, else the model's. */
  name: z.string(),
  port: z.number().int(),
  presetId: z.string().optional(),
});
export type DockerLostServer = z.infer<typeof dockerLostServerSchema>;

/** "Riavvia i server che erano attivi": the servers Docker took down, and whether they are being started again. */
export const dockerRecoverySchema = z.object({ servers: z.array(dockerLostServerSchema), restoring: z.boolean() });
export type DockerRecovery = z.infer<typeof dockerRecoverySchema>;
