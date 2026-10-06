import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopBridge } from '../contract/bridge';

/** The only API the renderer gets from Electron. Everything else goes through the core HTTP API. */
const bridge: DesktopBridge = {
  connection: () => ipcRenderer.invoke('gpubench:connection') as ReturnType<DesktopBridge['connection']>,
  platform: process.platform,
  pickFile: (opts) => ipcRenderer.invoke('gpubench:pick-file', opts) as Promise<string | null>,
  pickFolder: (opts) => ipcRenderer.invoke('gpubench:pick-folder', opts) as Promise<string | null>,
  openExternal: (url) => ipcRenderer.invoke('gpubench:open-external', url) as Promise<void>,
  revealPath: (p) => ipcRenderer.invoke('gpubench:reveal', p) as Promise<void>,
  setTitleBarTheme: (t) => ipcRenderer.invoke('gpubench:titlebar-theme', t) as Promise<void>,
  saveHfToken: (token) => ipcRenderer.invoke('gpubench:hf-token-save', token) as Promise<{ ok: boolean; secure: boolean }>,
  clearHfToken: () => ipcRenderer.invoke('gpubench:hf-token-clear') as Promise<void>,
  saveFile: (opts) => ipcRenderer.invoke('gpubench:save-file', opts) as Promise<string | null>,
};

contextBridge.exposeInMainWorld('gpubench', bridge);
