import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeImage, nativeTheme, Notification, safeStorage, shell, Tray, utilityProcess } from 'electron';
import * as fsSync from 'node:fs';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import v8 from 'node:v8';
import { exposeOnGlobal, startShell } from './shell';
import { runCommand } from './tray-support';

/** Electron main entry: the real Electron and process, wired into the testable shell. */
startShell(
  { app, BrowserWindow, dialog, ipcMain, nativeTheme, safeStorage, shell, utilityProcess, Tray, Menu, nativeImage, Notification, clipboard },
  {
    env: process.env,
    platform: process.platform,
    argv: process.argv,
    dirname: __dirname,
    resourcesPath: process.resourcesPath,
    home: os.homedir(),
    execPath: process.execPath,
    fs,
    run: runCommand,
    write: (stream, d) => process[stream].write(d),
    takeCoverage: () => v8.takeCoverage(),
    expose: exposeOnGlobal,
    legacy: { sync: fsSync, async: fs, hostname: os.hostname(), kill: process.kill.bind(process) },
  },
);
