/**
 * The product's name and id in the main process: window title, tray menu and tooltip, notifications,
 * dialogs, the login item and the Linux autostart entry. Kept in one place so a rename touches only
 * this file (and the migration of the OS-level ids below).
 */
export const APP_NAME = 'GPU Bench';

/** File-safe id: the Linux autostart entry is `${APP_ID}.desktop` (~/.config/autostart). */
export const APP_ID = 'gpu-bench';
