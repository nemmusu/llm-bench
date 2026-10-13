import { z } from 'zod';
import { customEnginesSettingSchema } from './custom-engines';
import { engineConfigSchema, launchParamsSchema } from './engines';
import { closeBehaviorSchema, serverPresetsSettingSchema } from './servers';

export const SETTINGS_SCHEMA_VERSION = 1;

export const settingsSchema = z.object({
  schema: z.literal(SETTINGS_SCHEMA_VERSION).default(SETTINGS_SCHEMA_VERSION),
  language: z.enum(['it', 'en']).default('it'),
  theme: z.enum(['system', 'light', 'dark']).default('system'),
  density: z.enum(['comfortable', 'compact']).default('comfortable'),
  expertMode: z.boolean().default(false),
  onboardingDone: z.boolean().default(false),
  /** Where run JSON files live; may be a shared/synced folder. Empty = default app data folder. */
  resultsDir: z.string().default(''),
  /** Where downloaded models go. Empty = default. */
  modelsDir: z.string().default(''),
  /** Extra folders scanned for existing models. */
  extraModelDirs: z.array(z.string()).default([]),
  scanKnownLocations: z.boolean().default(true),
  /** Windows: user opted in to the elevated standby-list purge task for real cold loads. */
  coldCacheOptIn: z.boolean().default(false),
  /** Last benchmark choices, restored on the home screen. */
  lastEngine: engineConfigSchema.optional(),
  lastModelId: z.string().optional(),
  lastProfile: z.enum(['quick', 'standard', 'full', 'custom', 'tune']).default('quick'),
  lastParams: launchParamsSchema.optional(),
  /** HF token is never stored here (main process keeps it encrypted with safeStorage). */
  hasHfToken: z.boolean().default(false),
  telemetryIntervalMs: z.number().int().min(100).max(5000).default(250),
  // ---- engines: custom engines and forks (contract/custom-engines.ts) ----
  /** "Motori personalizzati": forks and other OpenAI servers; invalid entries are dropped on read, never the whole file. */
  customEngines: customEnginesSettingSchema,
  // ---- servers and tray (contract/servers.ts) ----
  /** "I tuoi preset" of the Server page; invalid entries are dropped on read, never the whole file. */
  serverPresets: serverPresetsSettingSchema,
  /** Closing the window: hide to the tray while a server runs (default), always hide, or quit. */
  closeBehavior: closeBehaviorSchema.default('tray-if-servers'),
  /** "Avvia GPU Bench all'accesso": opt-in (Windows login item, Linux autostart entry). */
  launchAtLogin: z.boolean().default(false),
});
export type Settings = z.infer<typeof settingsSchema>;

export const defaultSettings = (): Settings => settingsSchema.parse({});
