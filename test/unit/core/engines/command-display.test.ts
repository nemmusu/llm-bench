import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  API_KEY_PLACEHOLDER,
  HF_PLACEHOLDER,
  displayCommand,
  quoteBash,
  quotePowerShell,
  redactArgv,
  redactEnv,
  secretPlaceholder,
} from '../../../../src/core/engines/command-display';

/**
 * POSIX shell word splitting for what displayCommand emits: single quotes, backslash escapes,
 * whitespace. Any unquoted character the shell would interpret is a test failure.
 */
function shellWords(s: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inWord = false;
  for (let i = 0; i < s.length; ) {
    const ch = s[i] as string;
    if (ch === "'") {
      const end = s.indexOf("'", i + 1);
      if (end < 0) throw new Error('unterminated quote');
      cur += s.slice(i + 1, end);
      i = end + 1;
      inWord = true;
    } else if (ch === '\\') {
      cur += s[i + 1] ?? '';
      i += 2;
      inWord = true;
    } else if (ch === ' ' || ch === '\t' || ch === '\n') {
      if (inWord) out.push(cur);
      cur = '';
      inWord = false;
      i++;
    } else {
      if (!/[A-Za-z0-9_\-.,/:=+@%]/.test(ch)) throw new Error(`unsafe unquoted character ${JSON.stringify(ch)}`);
      cur += ch;
      inWord = true;
      i++;
    }
  }
  if (inWord) out.push(cur);
  return out;
}

const PS_Q = new Set(["'", '\u2018', '\u2019', '\u201a', '\u201b']);

/** PowerShell single-quoted string literal (tokenizer rule: a doubled quote yields the second char). */
function psString(s: string, start: number): [string, number] {
  if (!PS_Q.has(s[start] as string)) throw new Error(`expected a quote at ${start}`);
  let out = '';
  let i = start + 1;
  for (;;) {
    if (i >= s.length) throw new Error('unterminated string');
    const c = s[i] as string;
    if (PS_Q.has(c)) {
      if (!PS_Q.has(s[i + 1] as string)) return [out, i + 1];
      out += s[i + 1];
      i += 2;
      continue;
    }
    out += c;
    i++;
  }
}

/** Parses `$env:A='x'; Set-Item -LiteralPath 'Env:B' -Value 'y'; & 'prog' arg 'arg'` back. */
function psParse(s: string): { env: Record<string, string>; argv: string[] } {
  const env: Record<string, string> = {};
  let i = 0;
  for (;;) {
    const m = /^\$env:([A-Za-z_][A-Za-z0-9_]*)=/.exec(s.slice(i));
    if (m) {
      const [v, next] = psString(s, i + m[0].length);
      env[m[1] as string] = v;
      expect(s.slice(next, next + 2)).toBe('; ');
      i = next + 2;
      continue;
    }
    if (s.startsWith('Set-Item -LiteralPath ', i)) {
      const [name, a] = psString(s, i + 'Set-Item -LiteralPath '.length);
      expect(s.slice(a, a + 8)).toBe(' -Value ');
      const [v, b] = psString(s, a + 8);
      env[name.replace(/^Env:/, '')] = v;
      expect(s.slice(b, b + 2)).toBe('; ');
      i = b + 2;
      continue;
    }
    break;
  }
  expect(s.slice(i, i + 2)).toBe('& ');
  i += 2;
  const argv: string[] = [];
  while (i < s.length) {
    if (PS_Q.has(s[i] as string)) {
      const [v, next] = psString(s, i);
      argv.push(v);
      i = next;
    } else {
      const end = s.indexOf(' ', i);
      const tok = s.slice(i, end < 0 ? s.length : end);
      expect(tok).toMatch(/^(?:-{1,2}[A-Za-z][A-Za-z0-9_-]*|[A-Za-z][A-Za-z0-9_-]*|-?[1-9][0-9]*|0)$/);
      argv.push(tok);
      i += tok.length;
    }
    if (i < s.length) {
      expect(s[i]).toBe(' ');
      i++;
    }
  }
  return { env, argv };
}

/** Strings a process can actually receive as an argument (no NUL). */
const argArb = fc.string({ unit: fc.oneof(fc.constantFrom("'", '"', '\u2019', '\u2018', ' ', '\n', '$', '`', '\\', '%', '!', '*', '~', '#', ';', '&', '-', '='), fc.constantFrom('a', 'Z', '0', '_', '.', '/'), fc.string({ unit: 'binary', minLength: 1, maxLength: 1 })) }).map((s) => s.replace(/\0/g, ''));
const nameArb = fc.stringMatching(/^[A-Za-z_][A-Za-z0-9_]{0,12}$/);

describe('displayCommand', () => {
  it('renders the documented PowerShell and bash forms', () => {
    const d = displayCommand(['C:\\llama\\llama-server.exe', '-m', 'C:\\models\\x.gguf', '--port', '8080', '-fa', 'on'], { CUDA_VISIBLE_DEVICES: '0' });
    expect(d.powershell).toBe("$env:CUDA_VISIBLE_DEVICES='0'; & 'C:\\llama\\llama-server.exe' -m 'C:\\models\\x.gguf' --port 8080 -fa on");
    const b = displayCommand(['/opt/llama/llama-server', '-m', '/models/My Model.gguf', '--host', '127.0.0.1'], { LD_LIBRARY_PATH: '/opt/llama' });
    expect(b.bash).toBe("LD_LIBRARY_PATH=/opt/llama /opt/llama/llama-server -m '/models/My Model.gguf' --host 127.0.0.1");
  });

  it('quotes odd command words and env names', () => {
    expect(displayCommand([])).toEqual({ powershell: '', bash: '' });
    expect(displayCommand(['A=b', 'x']).bash).toBe("'A=b' x");
    expect(displayCommand(['if']).bash).toBe("'if'");
    const weird = displayCommand(['prog'], { 'ProgramFiles(x86)': 'C:\\P', OK: 'v' });
    expect(weird.bash).toBe("env 'ProgramFiles(x86)=C:\\P' OK=v prog");
    expect(weird.powershell).toBe("Set-Item -LiteralPath 'Env:ProgramFiles(x86)' -Value 'C:\\P'; $env:OK='v'; & 'prog'");
  });

  it('quoting helpers leave simple tokens bare', () => {
    expect(quoteBash('--ctx-size')).toBe('--ctx-size');
    expect(quoteBash("it's")).toBe("'it'\\''s'");
    expect(quotePowerShell('--port')).toBe('--port');
    expect(quotePowerShell('8080')).toBe('8080');
    expect(quotePowerShell('1kb')).toBe("'1kb'");
    expect(quotePowerShell('--%')).toBe("'--%'");
    expect(quotePowerShell('a,b')).toBe("'a,b'");
    expect(quotePowerShell("it’s")).toBe("'it’’s'");
  });

  it('property: bash output parses back to the exact argv and env', () => {
    fc.assert(
      fc.property(fc.array(argArb, { minLength: 1, maxLength: 8 }), fc.dictionary(nameArb, argArb, { maxKeys: 3 }), (argv, env) => {
        const words = shellWords(displayCommand(argv, env).bash);
        const n = Object.keys(env).length;
        const assigns = words.slice(0, n);
        expect(Object.fromEntries(assigns.map((w) => [w.slice(0, w.indexOf('=')), w.slice(w.indexOf('=') + 1)]))).toEqual(env);
        expect(words.slice(n)).toEqual(argv);
      }),
      { numRuns: 400 },
    );
  });

  it('property: bash with non-identifier env names goes through env(1)', () => {
    fc.assert(
      fc.property(fc.array(argArb, { minLength: 1, maxLength: 4 }), argArb, (argv, v) => {
        const words = shellWords(displayCommand(argv, { 'A-B': v }).bash);
        expect(words.slice(0, 2)).toEqual(['env', `A-B=${v}`]);
        expect(words.slice(2)).toEqual(argv);
      }),
    );
  });

  it('property: PowerShell output parses back to the exact argv and env', () => {
    fc.assert(
      fc.property(
        fc.array(argArb, { minLength: 1, maxLength: 8 }),
        fc.dictionary(fc.oneof(nameArb, fc.string({ minLength: 1, maxLength: 6 })), argArb, { maxKeys: 3 }),
        (argv, env) => {
          const parsed = psParse(displayCommand(argv, env).powershell);
          expect(parsed.argv).toEqual(argv);
          expect(parsed.env).toEqual(env);
        },
      ),
      { numRuns: 400 },
    );
  });
});

describe('redaction', () => {
  it('maps secret env names to placeholders', () => {
    expect(secretPlaceholder('HF_TOKEN')).toBe(HF_PLACEHOLDER);
    expect(secretPlaceholder('hugging_face_hub_token')).toBe(HF_PLACEHOLDER);
    expect(secretPlaceholder('OPENAI_API_KEY')).toBe(API_KEY_PLACEHOLDER);
    expect(secretPlaceholder('APIKEY')).toBe(API_KEY_PLACEHOLDER);
    expect(secretPlaceholder('GITHUB_TOKEN')).toBe('<TOKEN>');
    expect(secretPlaceholder('DB_PASSWORD')).toBe('<SECRET>');
    expect(secretPlaceholder('CUDA_VISIBLE_DEVICES')).toBeUndefined();
    expect(secretPlaceholder('TOKENIZERS_PARALLELISM')).toBeUndefined();
    expect(redactEnv({ HF_TOKEN: 'hf_abc', EMPTY_TOKEN: '', PATH: '/bin' })).toEqual({ HF_TOKEN: '<HF_TOKEN>', EMPTY_TOKEN: '', PATH: '/bin' });
  });

  it('hides secret flags, NAME=value args and Authorization headers', () => {
    expect(
      redactArgv([
        'vllm', '--api-key', 'sk-1', '--hf-token=hf_2', '-hft', 'hf_3', '--token', 't4', '-e', 'HF_TOKEN=hf_5', '-e', 'FOO=bar',
        '-H', 'Authorization: Bearer abc', 'authorization:xyz', 'a-b=c', 'HF_TOKEN=', '--port', '8000', '--api-key',
      ]),
    ).toEqual([
      'vllm', '--api-key', '<API_KEY>', '--hf-token=<HF_TOKEN>', '-hft', '<HF_TOKEN>', '--token', '<TOKEN>', '-e', 'HF_TOKEN=<HF_TOKEN>', '-e', 'FOO=bar',
      '-H', 'Authorization: Bearer <API_KEY>', 'authorization:<API_KEY>', 'a-b=c', 'HF_TOKEN=', '--port', '8000', '--api-key',
    ]);
  });

  it('property: a secret never survives redaction', () => {
    const secret = fc.stringMatching(/^[A-Za-z0-9_]{12,30}$/);
    fc.assert(
      fc.property(secret, fc.array(fc.constantFrom('-m', 'x.gguf', '--port', '8080'), { maxLength: 4 }), (s, other) => {
        const argv = [...other, '--api-key', s, `--hf-token=${s}`, '-e', `HF_TOKEN=${s}`, `Authorization: Bearer ${s}`, ...other];
        const env = { HUGGINGFACE_TOKEN: s, MY_API_KEY: s, X_TOKEN: s };
        const out = JSON.stringify([redactArgv(argv), redactEnv(env), displayCommand(redactArgv(argv), redactEnv(env))]);
        expect(out).not.toContain(s);
      }),
    );
  });
});
