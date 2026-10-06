import { app, BrowserWindow, dialog, ipcMain, nativeTheme, safeStorage, shell, utilityProcess } from 'electron';
import { promises as fs } from 'node:fs';
import v8 from 'node:v8';
import { startShell } from './shell';

/** Electron main entry: the real Electron and process, wired into the testable shell. */
startShell(
  { app, BrowserWindow, dialog, ipcMain, nativeTheme, safeStorage, shell, utilityProcess },
  {
    env: process.env,
    platform: process.platform,
    dirname: __dirname,
    resourcesPath: process.resourcesPath,
    fs,
    write: (stream, d) => process[stream].write(d),
    takeCoverage: () => v8.takeCoverage(),
  },
);
