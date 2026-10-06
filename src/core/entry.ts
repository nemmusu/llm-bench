/**
 * Core process entry: inside Electron as a utilityProcess, or standalone with `node out/core/index.cjs`
 * (browser mode, tests). All the logic is in bootstrap.ts.
 */
import { boot, onBootError, processBootEnv } from './bootstrap';

declare const __APP_VERSION__: string;

const host = processBootEnv(__dirname, __APP_VERSION__);
void boot(host).catch(onBootError(host));
