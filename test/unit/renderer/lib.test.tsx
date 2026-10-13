import { act, render, renderHook, screen, waitFor } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cn } from '../../../src/renderer/lib/cn';
import { formatCommand, quoteBash, quotePowerShell } from '../../../src/renderer/lib/command';
import { navIdFor, pageTitleKey } from '../../../src/renderer/lib/nav';
import { applyDocumentTheme, prefersReducedMotion, resolveTheme, TITLE_BAR_COLORS, watchSystemTheme } from '../../../src/renderer/lib/theme';
import { useTweened } from '../../../src/renderer/lib/use-tweened';
import { ApiProvider, EventsProvider, useApi, useCoreConnected, useServerEvents } from '../../../src/renderer/lib/api-context';
import { SETTINGS_QUERY_KEY, SettingsProvider, useSettings } from '../../../src/renderer/lib/settings';
import { useHealth } from '../../../src/renderer/lib/queries';
import type { ServerEvent } from '../../../src/contract/events';
import { fakeApi, newQueryClient } from './helpers';

function mockMatchMedia(matches: Record<string, boolean>) {
  const listeners = new Set<(e: MediaQueryListEvent) => void>();
  const mm = vi.fn((q: string) => ({
    matches: matches[q] ?? false,
    media: q,
    addEventListener: (_: string, l: (e: MediaQueryListEvent) => void) => listeners.add(l),
    removeEventListener: (_: string, l: (e: MediaQueryListEvent) => void) => listeners.delete(l),
  }));
  vi.stubGlobal('matchMedia', mm);
  return { fire: (dark: boolean) => listeners.forEach((l) => l({ matches: dark } as MediaQueryListEvent)), listeners };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete (window as { gpubench?: unknown }).gpubench;
});

describe('cn', () => {
  it('merges classes and resolves conflicts on custom scales', () => {
    expect(cn('px-2', 'px-4')).toBe('px-4');
    expect(cn('text-2xs text-fg-2', 'text-sm')).toBe('text-fg-2 text-sm');
    const off = Number('0') > 0;
    expect(cn('p-card', off && 'x', 'p-2')).toBe('p-2');
  });
});

describe('command formatting', () => {
  it('quotes only when needed', () => {
    expect(quotePowerShell('C:\\models\\a.gguf')).toBe('C:\\models\\a.gguf');
    expect(quotePowerShell("it's here")).toBe("'it''s here'");
    expect(quoteBash('/opt/x')).toBe('/opt/x');
    expect(quoteBash("a b'c")).toBe("'a b'\\''c'");
  });

  it('formats multi-line commands for both shells', () => {
    const argv = ['C:\\LLM Bench\\llama-server.exe', '--model', 'C:\\m.gguf', '--no-webui', '-v', '--n-predict', '-1', '--port', '80'];
    expect(formatCommand(argv, 'powershell', { CUDA_VISIBLE_DEVICES: "0'" })).toBe(
      [
        "$env:CUDA_VISIBLE_DEVICES = '0'''",
        "& 'C:\\LLM Bench\\llama-server.exe' `",
        '  --model C:\\m.gguf `',
        '  --no-webui `',
        '  -v `',
        '  --n-predict -1 `',
        '  --port 80',
      ].join('\n'),
    );
    expect(formatCommand(['llama', '--port', '80'], 'bash', { A: 'b c' })).toBe(["A='b c' llama \\", '  --port 80'].join('\n'));
    expect(formatCommand(['llama'], 'bash')).toBe('llama');
    expect(formatCommand([], 'bash')).toBe('');
    expect(formatCommand(['C:\\x.exe', '--a'], 'powershell')).toBe('C:\\x.exe `\n  --a');
    // Subcommands stay on the first line; the image after the flags gets its own.
    expect(formatCommand(['docker', 'run', '--rm', '--gpus', 'all', 'vllm/vllm-openai:v0.12.0', '--model', 'Qwen/Qwen3-8B'], 'bash')).toBe(
      ['docker run \\', '  --rm \\', '  --gpus all \\', '  vllm/vllm-openai:v0.12.0 \\', '  --model Qwen/Qwen3-8B'].join('\n'),
    );
    expect(formatCommand(['vllm', 'serve', 'Qwen/Qwen3-8B'], 'bash')).toBe('vllm serve Qwen/Qwen3-8B');
  });
});

describe('nav', () => {
  it('maps paths to sidebar entries and titles', () => {
    expect(navIdFor('/')).toBe('benchmark');
    expect(navIdFor('/run/1')).toBe('benchmark');
    expect(navIdFor('/results/1')).toBe('results');
    expect(navIdFor('/compare')).toBe('results');
    expect(navIdFor('/monitor')).toBe('monitor');
    expect(navIdFor('/welcome')).toBeUndefined();
    expect(pageTitleKey('/welcome')).toBe('nav.welcome');
    expect(pageTitleKey('/run/x')).toBe('nav.run');
    expect(pageTitleKey('/results/x')).toBe('nav.result');
    expect(pageTitleKey('/compare')).toBe('nav.compare');
    expect(pageTitleKey('/settings')).toBe('nav.settings');
    expect(pageTitleKey('/nope')).toBe('nav.benchmark');
  });
});

describe('theme', () => {
  it('resolves system through prefers-color-scheme', () => {
    mockMatchMedia({ '(prefers-color-scheme: dark)': true });
    expect(resolveTheme('system')).toBe('dark');
    expect(resolveTheme('light')).toBe('light');
    vi.stubGlobal('matchMedia', undefined);
    expect(resolveTheme('system')).toBe('light');
    expect(prefersReducedMotion()).toBe(false);
  });

  it('writes attributes and updates the native title bar', () => {
    const setTitleBarTheme = vi.fn(async () => undefined);
    (window as { gpubench?: unknown }).gpubench = { setTitleBarTheme };
    applyDocumentTheme('dark', 'compact');
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(document.documentElement.dataset.density).toBe('compact');
    expect(setTitleBarTheme).toHaveBeenCalledWith(TITLE_BAR_COLORS.dark);
    const failing = vi.fn(async () => {
      throw new Error('no window');
    });
    (window as { gpubench?: unknown }).gpubench = { setTitleBarTheme: failing };
    applyDocumentTheme('light', 'comfortable');
    expect(failing).toHaveBeenCalled();
  });

  it('watches OS theme changes', () => {
    const mm = mockMatchMedia({});
    const seen: string[] = [];
    const stop = watchSystemTheme((t) => seen.push(t));
    mm.fire(true);
    mm.fire(false);
    stop();
    expect(mm.listeners.size).toBe(0);
    expect(seen).toEqual(['dark', 'light']);
    vi.stubGlobal('matchMedia', undefined);
    expect(watchSystemTheme(() => undefined)()).toBeUndefined();
  });

  it('detects reduced motion', () => {
    mockMatchMedia({ '(prefers-reduced-motion: reduce)': true });
    expect(prefersReducedMotion()).toBe(true);
  });
});

describe('useTweened', () => {
  it('jumps straight to the value with reduced motion', () => {
    mockMatchMedia({ '(prefers-reduced-motion: reduce)': true });
    const { result, rerender } = renderHook(({ v }) => useTweened(v), { initialProps: { v: 1 } });
    rerender({ v: 10 });
    expect(result.current).toBe(10);
  });

  it('animates towards the target', async () => {
    mockMatchMedia({});
    let now = 0;
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => frames.push(cb));
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    const { result, rerender, unmount } = renderHook(({ v }) => useTweened(v, 100), { initialProps: { v: 0 } });
    rerender({ v: 100 });
    now = 50;
    // The first frame belongs to the cancelled effect for the initial value: run the latest one.
    act(() => frames.at(-1)?.(now));
    expect(result.current).toBeGreaterThan(0);
    expect(result.current).toBeLessThan(100);
    now = 100;
    act(() => frames.at(-1)?.(now));
    expect(result.current).toBe(100);
    unmount();
    const { result: r0 } = renderHook(() => useTweened(5, 0));
    expect(r0.current).toBe(5);
  });
});

describe('api-context', () => {
  it('useApi requires a provider', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(() => renderHook(() => useApi())).toThrow(/ApiProvider/);
  });

  it('EventsProvider fans out events and tracks connection', async () => {
    const api = fakeApi();
    const got: ServerEvent[] = [];
    function Probe() {
      const connected = useCoreConnected();
      useServerEvents((e) => got.push(e));
      return <p>{connected ? 'on' : 'off'}</p>;
    }
    render(
      <ApiProvider api={api}>
        <EventsProvider>
          <Probe />
        </EventsProvider>
      </ApiProvider>,
    );
    expect(await screen.findByText('on')).toBeTruthy();
    act(() => api.emit({ type: 'runs.changed' }));
    expect(got).toEqual([{ type: 'runs.changed' }]);
    act(() => api.setConnected(false));
    expect(screen.getByText('off')).toBeTruthy();
  });

  it('useCoreConnected defaults to false without a provider', () => {
    const { result } = renderHook(() => useCoreConnected());
    expect(result.current).toBe(false);
    renderHook(() => useServerEvents(() => undefined));
  });
});

describe('SettingsProvider', () => {
  function wrapper(api: ReturnType<typeof fakeApi>) {
    const qc = newQueryClient();
    return ({ children }: { children: React.ReactNode }) => (
      <ApiProvider api={api}>
        <QueryClientProvider client={qc}>
          <SettingsProvider>{children}</SettingsProvider>
        </QueryClientProvider>
      </ApiProvider>
    );
  }

  it('loads settings, applies theme/lang and saves changes', async () => {
    mockMatchMedia({});
    const api = fakeApi({ theme: 'dark', language: 'en', density: 'compact' });
    const { result } = renderHook(() => useSettings(), { wrapper: wrapper(api) });
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.resolvedTheme).toBe('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(document.documentElement.lang).toBe('en');
    act(() => result.current.update({ theme: 'light' }));
    await waitFor(() => expect(api.settings.theme).toBe('light'));
    expect(document.documentElement.dataset.theme).toBe('light');
  });

  it('keeps local edits made while a save is in flight', async () => {
    mockMatchMedia({});
    const api = fakeApi();
    const { result } = renderHook(() => useSettings(), { wrapper: wrapper(api) });
    await waitFor(() => expect(result.current.ready).toBe(true));
    let release: (() => void) | undefined;
    const original = api.put;
    let calls = 0;
    api.put = vi.fn(async (path: string, body?: unknown) => {
      // Hold the first save (theme) until the second one (language) has completed.
      if (calls++ === 0) await new Promise<void>((r) => (release = r));
      return original(path, body);
    }) as typeof api.put;
    act(() => result.current.update({ theme: 'dark' }));
    act(() => result.current.update({ language: 'en' }));
    // Saves are serialized: the second waits for the first, and local values never flicker back.
    await waitFor(() => expect(result.current.settings.language).toBe('en'));
    await waitFor(() => expect(release).toBeTypeOf('function'));
    await act(async () => release?.());
    await waitFor(() => expect(api.settings.language).toBe('en'));
    expect(api.settings.theme).toBe('dark');
    expect(result.current.settings.language).toBe('en');
    expect(result.current.settings.theme).toBe('dark');
  });

  it('falls back to defaults when the API fails and follows the OS theme', async () => {
    const mm = mockMatchMedia({});
    const api = fakeApi({}, { failSettings: true });
    const { result } = renderHook(() => useSettings(), { wrapper: wrapper(api) });
    await waitFor(() => expect(result.current.ready).toBe(true), { timeout: 4000 });
    expect(result.current.settings.language).toBe('it');
    expect(result.current.resolvedTheme).toBe('light');
    act(() => mm.fire(true));
    expect(result.current.resolvedTheme).toBe('dark');
    act(() => result.current.update({ density: 'compact' }));
    await waitFor(() => expect(result.current.settings.density).toBe('compact'));
  });

  it('stores the saved settings as they are when the cache was cleared during the save', async () => {
    mockMatchMedia({});
    const api = fakeApi();
    const qc = newQueryClient();
    const wrap = ({ children }: { children: React.ReactNode }) => (
      <ApiProvider api={api}>
        <QueryClientProvider client={qc}>
          <SettingsProvider>{children}</SettingsProvider>
        </QueryClientProvider>
      </ApiProvider>
    );
    const { result } = renderHook(() => useSettings(), { wrapper: wrap });
    await waitFor(() => expect(result.current.ready).toBe(true));
    let release: (() => void) | undefined;
    const original = api.put;
    api.put = vi.fn(async (path: string, body?: unknown) => {
      await new Promise<void>((r) => (release = r));
      return original(path, body);
    }) as typeof api.put;
    act(() => result.current.update({ theme: 'dark' }));
    await waitFor(() => expect(release).toBeTypeOf('function'));
    // Nothing local is left to keep (e.g. the query cache was reset): the server answer wins as is.
    qc.removeQueries({ queryKey: SETTINGS_QUERY_KEY });
    await act(async () => release?.());
    await waitFor(() => expect(qc.getQueryData(SETTINGS_QUERY_KEY)).toMatchObject({ theme: 'dark' }));
    expect(api.settings.theme).toBe('dark');
  });

  it('useSettings requires a provider', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(() => renderHook(() => useSettings())).toThrow(/SettingsProvider/);
  });
});

describe('queries', () => {
  it('read the health route', async () => {
    const api = fakeApi();
    const qc = newQueryClient();
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <ApiProvider api={api}>
        <QueryClientProvider client={qc}>{children}</QueryClientProvider>
      </ApiProvider>
    );
    const { result } = renderHook(
      () => ({
        health: useHealth(),
      }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.health.data?.version).toBe('0.1.0'));
  });
});
