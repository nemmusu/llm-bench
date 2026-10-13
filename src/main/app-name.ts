/**
 * The product's name and id in the main process: window title, tray menu and tooltip, notifications,
 * dialogs, the login item and the Linux autostart entry. Kept in one place so a rename touches only
 * this file (and the migration of the OS-level ids below).
 */
export const APP_NAME = 'LLM Bench';

/** File-safe id: the Linux autostart entry is `${APP_ID}.desktop` (~/.config/autostart). */
export const APP_ID = 'llm-bench';

/**
 * The name before 0.4.0. Its data folder (userData), autostart entry and login item are moved to the
 * new name once (migrate.ts); internal markers that kept the old spelling (gpubench-<uuid>, the
 * gpubench=1 docker label, GPUBENCH_* variables…) are unchanged on purpose.
 */
export const LEGACY_APP_NAME = 'GPU Bench';
export const LEGACY_APP_ID = 'gpu-bench';
