import { describe, expect, it, vi } from 'vitest';
import type { DesktopBridge } from '../../../src/contract/bridge';

const exposed: Record<string, unknown> = {};
const invoke = vi.fn(async (...args: unknown[]) => args);

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: (key: string, api: unknown) => (exposed[key] = api) },
  ipcRenderer: { invoke: (...args: unknown[]) => invoke(...args) },
}));

describe('preload bridge', () => {
  it('exposes window.gpubench and maps every method to its IPC channel', async () => {
    await import('../../../src/preload/index');
    const b = exposed.gpubench as DesktopBridge;
    expect(b.platform).toBe(process.platform);
    await b.connection();
    await b.pickFile({ title: 't' });
    await b.pickFolder({ title: 'f' });
    await b.openExternal('https://x');
    await b.revealPath('/p');
    await b.setTitleBarTheme({ background: '#000', symbols: '#fff' });
    await b.saveHfToken('hf_x');
    await b.clearHfToken();
    await b.saveFile({ defaultName: 'r.csv', content: 'a' });
    await b.shellInfo();
    expect(invoke.mock.calls.map((c) => c[0])).toEqual([
      'gpubench:connection',
      'gpubench:pick-file',
      'gpubench:pick-folder',
      'gpubench:open-external',
      'gpubench:reveal',
      'gpubench:titlebar-theme',
      'gpubench:hf-token-save',
      'gpubench:hf-token-clear',
      'gpubench:save-file',
      'gpubench:shell-info',
    ]);
    expect(invoke.mock.calls[1]).toEqual(['gpubench:pick-file', { title: 't' }]);
  });
});
