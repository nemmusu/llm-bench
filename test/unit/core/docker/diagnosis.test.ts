import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  causeFrom,
  diagnoseDocker,
  diagnosisDeps,
  engineEvents,
  LOG_TAIL_BYTES,
  readTail,
  RESOURCE_SAVER_DEFAULT,
  resourceSaverFrom,
  type DiagnosisDeps,
} from '../../../../src/core/docker/diagnosis';
import { DOCKER_FIXTURES } from './helpers';

const fixture = (n: string) => path.join(DOCKER_FIXTURES, n);
const STUCK = readFileSync(fixture('desktop-backend-stuck.log'), 'utf8');
const OK = readFileSync(fixture('desktop-backend-resource-saver-ok.log'), 'utf8');
/** Real capture (2026-10-09): Resource Saver stopped the engine at 19:24:55 UTC and the stop never finished. */
const STUCK_AT = Date.parse('2026-10-09T19:24:55.162Z');

describe("Resource Saver in Docker Desktop's settings", () => {
  it("absent keys are Docker's defaults (on, 5 minutes); its own values win", () => {
    expect(resourceSaverFrom('{"AutoStart":false,"SettingsVersion":46}')).toEqual(RESOURCE_SAVER_DEFAULT);
    expect(resourceSaverFrom('{"UseResourceSaver":false,"AutoPauseTimeoutSeconds":900}')).toEqual({ enabled: false, timeoutSeconds: 900 });
    expect(resourceSaverFrom('{"AutoPauseTimeoutSeconds":0}')).toEqual(RESOURCE_SAVER_DEFAULT);
    expect(resourceSaverFrom('not json')).toEqual(RESOURCE_SAVER_DEFAULT);
    expect(resourceSaverFrom('null')).toEqual(RESOURCE_SAVER_DEFAULT);
  });
});

describe("the engine's life in Docker Desktop's log", () => {
  it('Resource Saver deciding to stop, and the engine states, from both log styles', () => {
    const events = engineEvents(STUCK);
    expect(events.map((e) => e.kind)).toEqual(['idle', 'idle', 'stopping', 'stopping']);
    expect(events[2]!.at).toBe(STUCK_AT);
    const monitor = engineEvents('[2026-10-09T19:24:55.162871900Z] [19:24:55.162871900Z][main.engines          ] setting engine linux/wsl state running -> stopping\n[2026-10-09T19:30:00Z][x] setting engine linux/wsl state stopping -> paused\nno stamp\n[2026-10-09T19:30:01.5Z][x] something else');
    expect(monitor.map((e) => [e.kind, e.at])).toEqual([
      ['stopping', STUCK_AT],
      ['other', Date.parse('2026-10-09T19:30:00.000Z')],
    ]);
  });

  it('a stop that never finished, after Resource Saver: "resource-saver", since when, and the lines', () => {
    const found = causeFrom(engineEvents(STUCK), STUCK_AT + 90 * 60_000);
    expect(found).toEqual({
      cause: 'resource-saver',
      since: '2026-10-09T19:24:55.162Z',
      evidence: [
        '2026-10-09 19:24:55 UTC · stopping VM',
        '2026-10-09 19:24:55 UTC · setting engine linux/wsl state running -> stopping',
        '2026-10-09 19:24:55 UTC · setting engine linux/wsl state stopping -> stopping',
      ],
    });
  });

  it('a normal Resource Saver stop (it reached "stopped"), a stop going on right now, or no stop at all: nothing to say', () => {
    expect(causeFrom(engineEvents(OK), Date.parse('2026-10-13T21:00:00Z'))).toBeUndefined();
    expect(causeFrom(engineEvents(STUCK), STUCK_AT + 30_000)).toBeUndefined();
    expect(causeFrom([], Date.now())).toBeUndefined();
  });

  it('stuck stopping without Resource Saver before it: "stuck-stopping"', () => {
    const quit = engineEvents('[2026-10-09T19:00:00Z][x] system idle for 5m0s -> reducing\n[2026-10-09T19:24:55Z][x] setting engine linux/wsl state running -> stopping');
    expect(causeFrom(quit, STUCK_AT + 3_600_000)).toMatchObject({ cause: 'stuck-stopping', evidence: ['2026-10-09 19:24:55 UTC · setting engine linux/wsl state running -> stopping'] });
  });
});

describe('diagnoseDocker', () => {
  function deps(files: Record<string, string>, over: Partial<DiagnosisDeps> = {}): DiagnosisDeps {
    const read = async (p: string) => {
      const v = files[p];
      if (v === undefined) throw new Error(`ENOENT ${p}`);
      return v;
    };
    return { platform: 'win32', env: { APPDATA: 'C:\\A', LOCALAPPDATA: 'C:\\L' }, readFile: read, readTail: read, now: () => STUCK_AT + 90 * 60_000, ...over };
  }
  const LOGS = 'C:\\L\\Docker\\log\\host';

  it("reads Docker Desktop's settings and both logs (the same lines once)", async () => {
    const d = await diagnoseDocker(
      deps({
        'C:\\A\\Docker\\settings-store.json': '{"AutoStart":false}',
        [`${LOGS}\\com.docker.backend.exe.log`]: STUCK,
        [`${LOGS}\\monitor.log`]: STUCK,
      }),
    );
    expect(d).toMatchObject({ cause: 'resource-saver', resourceSaver: { enabled: true, timeoutSeconds: 300 }, since: '2026-10-09T19:24:55.162Z' });
    expect(d.evidence).toHaveLength(3);
  });

  it('nothing in the logs: what LLM Bench saw itself, and the setting still', async () => {
    expect(await diagnoseDocker(deps({ 'C:\\A\\Docker\\settings-store.json': '{"UseResourceSaver":false}' }), 'version-timeout')).toEqual({
      cause: 'not-answering',
      evidence: [],
      resourceSaver: { enabled: false, timeoutSeconds: 300 },
    });
    expect(await diagnoseDocker(deps({}))).toEqual({ cause: 'unknown', evidence: [] });
    expect(await diagnoseDocker(deps({}, { env: {} }))).toEqual({ cause: 'unknown', evidence: [] });
    expect(await diagnoseDocker(deps({}, { platform: 'linux' }), 'calls-failing')).toEqual({ cause: 'not-answering', evidence: [] });
  });

  it('a folder standing in for Docker Desktop (tests, mockups): its settings and its log/host, never this PC\'s', async () => {
    const dir = path.join('C:', 'fake-dd');
    const d = await diagnoseDocker(
      deps(
        {
          [path.join(dir, 'settings-store.json')]: '{"AutoPauseTimeoutSeconds":600}',
          [path.join(dir, 'log', 'host', 'monitor.log')]: STUCK,
        },
        { dir },
      ),
    );
    expect(d).toMatchObject({ cause: 'resource-saver', resourceSaver: { enabled: true, timeoutSeconds: 600 } });
    expect(diagnosisDeps('win32', { GPUBENCH_DOCKER_DESKTOP_DIR: dir }, () => 0).dir).toBe(dir);
    expect(diagnosisDeps('win32', {}, () => 0).dir).toBeUndefined();
  });

  it('reads the end of a file, and the real files of this PC', async () => {
    const whole = await readTail(fixture('desktop-backend-ok-tail.txt').replace('-ok-tail.txt', '-resource-saver-ok.log'), LOG_TAIL_BYTES);
    expect(whole).toBe(OK);
    const end = await readTail(fixture('desktop-backend-resource-saver-ok.log'), 20);
    expect(end).toBe(OK.slice(-20));
    await expect(readTail(fixture('missing.log'), 10)).rejects.toThrow();
    const real = diagnosisDeps('win32', {}, () => 1);
    expect(await real.readFile(fixture('desktop-backend-resource-saver-ok.log'))).toBe(OK);
    expect(real.now()).toBe(1);
  });
});
