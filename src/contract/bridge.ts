/** API exposed by the Electron preload as `window.gpubench`. Absent in browser mode. */
export interface DesktopBridge {
  connection(): Promise<{ baseUrl: string; token: string }>;
  platform: string;
  pickFile(opts?: { title?: string; filters?: { name: string; extensions: string[] }[] }): Promise<string | null>;
  pickFolder(opts?: { title?: string }): Promise<string | null>;
  openExternal(url: string): Promise<void>;
  revealPath(path: string): Promise<void>;
  setTitleBarTheme(theme: { background: string; symbols: string }): Promise<void>;
  saveHfToken(token: string): Promise<{ ok: boolean; secure: boolean }>;
  clearHfToken(): Promise<void>;
  /** Shows the native "Save as" dialog and writes `content` (exports). Resolves to the path, or null if cancelled. */
  saveFile(opts: { defaultName: string; content: string; filters?: { name: string; extensions: string[] }[] }): Promise<string | null>;
}
