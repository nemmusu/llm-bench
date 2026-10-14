// "Anteprima comando" / "Come è stato avviato" of a program with commands around its server: every
// command, in the order it runs, secrets hidden in each.
import { describe, expect, it } from 'vitest';
import { launchParamsSchema } from '../../../../src/contract/engines';
import { launchRecordOf } from '../../../../src/core/bench/runner';
import { displayCommand, displayWithSteps, redactArgv, redactEnv } from '../../../../src/core/engines/command-display';
import type { LaunchPlan } from '../../../../src/core/engines/types';

const plan = (steps?: LaunchPlan['steps']): LaunchPlan => ({
  kind: 'command',
  argv: ['C:\\srv\\srv.exe', '--port', '8080', '--api-key', 'sk-123'],
  env: { HF_TOKEN: 'hf_abc', A: '1' },
  host: '127.0.0.1',
  port: 8080,
  params: launchParamsSchema.parse({}),
  engine: { kind: 'command', name: 'OpenAI server' },
  modelFiles: [],
  modelBytes: 0,
  marker: 'gpubench-x',
  ...(steps ? { steps } : {}),
});

describe('commands around a server, shown', () => {
  it('without steps: the server alone, as before', () => {
    const one = { powershell: 'a', bash: 'b' };
    expect(displayWithSteps(one, undefined, () => one)).toBe(one);
    expect(displayWithSteps(one, { before: [], after: [] }, () => one)).toBe(one);
  });

  it('every command in order under its heading, each with the environment, secrets hidden', () => {
    const redact = (argv: string[], env: Record<string, string>) => ({ argv: redactArgv(argv), env: redactEnv(env) });
    const r = launchRecordOf(plan({ before: [['prep', '--token', 'tk-1']], after: [['clean', 'a b']] }), displayCommand, redact);
    expect(r.argv).toEqual(['C:\\srv\\srv.exe', '--port', '8080', '--api-key', '<API_KEY>']);
    expect(r.display.bash.split('\n')).toEqual([
      '# before the server',
      "HF_TOKEN='<HF_TOKEN>' A=1 prep --token '<TOKEN>'",
      '# the server',
      "HF_TOKEN='<HF_TOKEN>' A=1 'C:\\srv\\srv.exe' --port 8080 --api-key '<API_KEY>'",
      '# after the server stops',
      "HF_TOKEN='<HF_TOKEN>' A=1 clean 'a b'",
    ]);
    expect(r.display.powershell.split('\n')[1]).toBe("$env:HF_TOKEN='<HF_TOKEN>'; $env:A='1'; & 'prep' --token '<TOKEN>'");
    // Only commands before: no heading after; no redactor: as planned.
    const plain = launchRecordOf(plan({ before: [['prep']], after: [] }), displayCommand, undefined);
    expect(plain.display.bash.split('\n')).toEqual(['# before the server', "HF_TOKEN=hf_abc A=1 prep", '# the server', "HF_TOKEN=hf_abc A=1 'C:\\srv\\srv.exe' --port 8080 --api-key sk-123"]);
    const after = launchRecordOf(plan({ before: [], after: [['bye']] }), displayCommand, undefined);
    expect(after.display.bash.split('\n')[0]).toBe('# the server');
  });
});
