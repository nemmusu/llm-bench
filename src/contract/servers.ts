/**
 * Servers for other programs: saved presets, network access, the API key, and the messages between
 * the core and the Electron main (tray icon, close-to-tray, "Avvia all'apertura").
 *
 *   GET    /api/servers/presets            -> ServerPreset[]
 *   POST   /api/servers/presets            (ServerPresetInput) -> ServerPreset
 *   PUT    /api/servers/presets/:id        (Partial<ServerPresetInput>) -> ServerPreset
 *   DELETE /api/servers/presets/:id        -> { ok: true }
 *   POST   /api/servers/presets/:id/start  -> ServerInfo (once it answers)
 *   GET    /api/servers/api-key            -> ServerApiKeyInfo (generated the first time)
 *   POST   /api/servers/api-key/regenerate -> ServerApiKeyInfo
 *   GET    /api/servers/notices            -> ServerNotice[] (starts that failed without anyone watching)
 *   DELETE /api/servers/notices/:id        -> { ok: true }
 *   GET    /api/servers/:id/log            -> ServerLog (secrets hidden)
 *   POST   /api/servers/:id/restart        -> ServerInfo (once it answers again)
 *
 * The rest of the server routes (list, plan, start, stop) are in api.ts.
 */
import { z } from 'zod';
import { engineConfigSchema, launchParamsSchema } from './engines';
import { appErrorSchema } from './errors';
import { recipeChoiceSchema } from './recipes';

/** Who can reach a server: this PC only (127.0.0.1), or other devices on the local network too (0.0.0.0, with the API key). */
export const serverNetworkSchema = z.enum(['local', 'lan']);
export type ServerNetwork = z.infer<typeof serverNetworkSchema>;

/** Ports a user may choose (below 1024 needs administrator rights on Linux). */
export const SERVER_PORT_MIN = 1024;
export const SERVER_PORT_MAX = 65535;
/** First port offered for a server; the next free one when it is taken (8081, 8082…). */
export const DEFAULT_SERVER_PORT = 8080;
export const serverPortSchema = z.number().int().min(SERVER_PORT_MIN).max(SERVER_PORT_MAX);

/** The model of a server: a library model, or a Hugging Face repo (+ GGUF file) downloaded first. */
export const serverModelSchema = z.object({
  localId: z.string().optional(),
  repo: z.string().optional(),
  file: z.string().optional(),
  revision: z.string().optional(),
});
export type ServerModel = z.infer<typeof serverModelSchema>;

/**
 * Where the settings of a server come from (said next to a preset): GPU Bench's choice, "Trova le
 * impostazioni migliori", one configuration of Risultati → Configurazioni, or typed by hand.
 */
export const serverSettingsSourceSchema = z.object({
  kind: z.enum(['auto', 'tuned', 'config', 'custom']),
  /** The test the settings come from ('tuned', 'config'). */
  runId: z.string().optional(),
  /** Index into that test's tuning.combinations. */
  combo: z.number().int().min(0).optional(),
});
export type ServerSettingsSource = z.infer<typeof serverSettingsSourceSchema>;

export const SERVER_PRESET_NAME_MAX = 60;
/** At most this many saved presets (the tray menu lists them all). */
export const SERVER_PRESETS_MAX = 40;

/** What a preset saves: the model, the engine, the settings, extra arguments (in params) and the port. */
export const serverPresetInputSchema = z.object({
  name: z.string().trim().min(1).max(SERVER_PRESET_NAME_MAX),
  engine: engineConfigSchema,
  model: serverModelSchema,
  /** The model as people read it ("Qwen3 8B · Q4_K_M"): lists and the tray. */
  modelLabel: z.string().trim().min(1).max(200),
  params: launchParamsSchema,
  /** Always the same port, so other programs keep working after a restart. Absent = the first free one from 8080. */
  port: serverPortSchema.optional(),
  network: serverNetworkSchema.default('local'),
  /** "Avvia all'apertura di GPU Bench": started when the app opens. Off unless the user turns it on. */
  autoStart: z.boolean().default(false),
  source: serverSettingsSourceSchema.optional(),
  /** "Comandi per questo modello" (contract/recipes.ts): absent = the model's recipe, if it has one; { use: false } = without. */
  recipe: recipeChoiceSchema.optional(),
});
export type ServerPresetInput = z.input<typeof serverPresetInputSchema>;

export const serverPresetSchema = serverPresetInputSchema.extend({
  id: z.string().min(1),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ServerPreset = z.infer<typeof serverPresetSchema>;

/**
 * settings.serverPresets, read leniently: an entry that does not validate (edited by hand, written by a
 * newer version) is dropped on read instead of resetting every setting.
 */
export const serverPresetsSettingSchema = z
  .array(z.unknown())
  .default([])
  .transform((list) =>
    list.flatMap((raw) => {
      const p = serverPresetSchema.safeParse(raw);
      return p.success ? [p.data] : [];
    }),
  );

/** What closing the window does: hide to the tray while a server runs (default), always hide, or quit. */
export const closeBehaviorSchema = z.enum(['tray-if-servers', 'tray', 'quit']);
export type CloseBehavior = z.infer<typeof closeBehaviorSchema>;

/**
 * Where the API key of network servers is kept: encrypted by the OS keyring (safeStorage), as plain
 * text in the app folder (Linux without a keyring: the UI warns), or only for this session (browser mode).
 */
export const serverApiKeyStorageSchema = z.enum(['encrypted', 'plain', 'memory']);
export type ServerApiKeyStorage = z.infer<typeof serverApiKeyStorageSchema>;

export const serverApiKeyInfoSchema = z.object({ key: z.string().min(16), storage: serverApiKeyStorageSchema });
export type ServerApiKeyInfo = z.infer<typeof serverApiKeyInfoSchema>;

/** The server's own output (last lines), with the API key hidden. */
export const serverLogSchema = z.object({ lines: z.array(z.string()) });
export type ServerLog = z.infer<typeof serverLogSchema>;

/** A start nobody was watching that failed: "Avvia all'apertura", or a preset started from the tray. */
export const serverNoticeSchema = z.object({
  id: z.string(),
  kind: z.enum(['autostart-failed', 'tray-start-failed']),
  presetId: z.string().optional(),
  /** The preset's name. */
  name: z.string(),
  error: appErrorSchema,
  at: z.string(),
});
export type ServerNotice = z.infer<typeof serverNoticeSchema>;

// ---- core ⇄ Electron main (utility process messages) -----------------------------------------------

/** A running server as the tray shows it. */
export const shellServerSchema = z.object({
  id: z.string(),
  modelName: z.string(),
  port: z.number().int(),
  /** The OpenAI-compatible address ("Copia indirizzo"). */
  url: z.string(),
  status: z.enum(['loading', 'ready']),
  network: serverNetworkSchema,
  presetName: z.string().optional(),
});
export type ShellServer = z.infer<typeof shellServerSchema>;

export const shellPresetSchema = z.object({
  id: z.string(),
  name: z.string(),
  port: z.number().int().optional(),
  /** One of the running servers was started from it. */
  running: z.boolean(),
});
export type ShellPreset = z.infer<typeof shellPresetSchema>;

/** Everything the main process needs for the tray and the window: sent whenever any of it changes. */
export const shellStateSchema = z.object({
  servers: z.array(shellServerSchema),
  presets: z.array(shellPresetSchema),
  closeBehavior: closeBehaviorSchema,
  launchAtLogin: z.boolean(),
  language: z.enum(['it', 'en']),
});
export type ShellState = z.infer<typeof shellStateSchema>;

/** Tray menu commands the core carries out. */
export const trayActionSchema = z.enum(['stop', 'restart', 'stop-all', 'start-preset']);
export type TrayAction = z.infer<typeof trayActionSchema>;

/** Core → main. */
export const coreToShellSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ready'), port: z.number().int() }),
  z.object({ type: z.literal('shell-state'), state: shellStateSchema }),
  /** A preset started from the tray or at start-up did not start: the main process shows a notification. */
  z.object({ type: z.literal('shell-notice'), notice: z.object({ kind: z.literal('start-failed'), name: z.string() }) }),
  /** A new API key: the main process keeps it encrypted and answers with `server-api-key`. */
  z.object({ type: z.literal('server-api-key-save'), key: z.string() }),
]);
export type CoreToShell = z.infer<typeof coreToShellSchema>;

/** Main → core. */
export const shellToCoreSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('shutdown') }),
  z.object({ type: z.literal('hf-token'), token: z.string().nullable() }),
  /** The saved API key (at start-up), or the confirmation that a new one was saved. */
  z.object({ type: z.literal('server-api-key'), key: z.string(), storage: z.enum(['encrypted', 'plain']) }),
  /** The window is up: start the presets marked "Avvia all'apertura di GPU Bench". */
  z.object({ type: z.literal('autostart') }),
  z.object({ type: z.literal('tray'), action: trayActionSchema, id: z.string().optional() }),
]);
export type ShellToCore = z.infer<typeof shellToCoreSchema>;
