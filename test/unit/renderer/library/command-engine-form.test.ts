// The add/edit dialog's form for a program with an OpenAI API: commands one per line before and after
// the server, the KV types of {kv}, examples, and the preview with example values.
import { describe, expect, it } from 'vitest';
import { customEngineSchema } from '../../../../src/contract/custom-engines';
import {
  COMMAND_EXAMPLES,
  commandLinesOf,
  commandPreview,
  draftOf,
  EMPTY_FORM,
  formOf,
  sampleValues,
  usesKv,
  withExample,
  type CustomEngineForm,
} from '../../../../src/renderer/components/engines/custom-engine-form';

const form = (o: Partial<CustomEngineForm> = {}): CustomEngineForm => ({ ...EMPTY_FORM, base: 'openai-server', mode: 'command', name: 'Mio', ...o });
const labels = { before: 'before', server: 'server', after: 'after' };

describe('program with an OpenAI API: the form', () => {
  it('commands one per line before and after; the KV types only when {kv} is used', () => {
    expect(commandLinesOf(' a \n\n b\r\nc ')).toEqual(['a', 'b', 'c']);
    const { draft, problems } = draftOf(form({ before: 'prep {model}\n\n', template: ' srv --port {port} -c {ctx} ', after: 'clean', kvTypes: ['q4_0', 'f16'] }));
    expect(problems).toEqual({});
    expect(draft?.run).toEqual({ mode: 'command', template: 'srv --port {port} -c {ctx}', api: 'completions', before: ['prep {model}'], after: ['clean'] });
    expect(usesKv(form({ template: 'srv --port {port}', before: 'x {kv}' }))).toBe(true);
    expect(draftOf(form({ template: 'srv --port {port} --kv {kv}', kvTypes: ['q4_0', 'f16'] })).draft?.run).toEqual({
      mode: 'command',
      template: 'srv --port {port} --kv {kv}',
      api: 'completions',
      kvTypes: ['f16', 'q4_0'],
    });
    expect(draftOf(form({ template: 'srv --port {port} --kv {kv}', kvTypes: [] })).problems).toEqual({ kvTypes: { key: 'kvTypesNone' } });
  });

  it('says which line of a command list is wrong, and why', () => {
    expect(draftOf(form({ template: 'srv --port {port}', before: 'ok\nprep {what} {nope}' })).problems).toEqual({
      before: { key: 'templateProblems.unknown_placeholder', params: { names: '{what}, {nope}' }, line: 2 },
    });
    expect(draftOf(form({ template: 'srv --port {port}', after: '"open' })).problems).toEqual({ after: { key: 'templateProblems.unbalanced_quote', line: 1 } });
    expect(draftOf(form({ template: 'srv --port {port}', after: 'x'.repeat(4001) })).problems).toEqual({ after: { key: 'tooLong', line: 1 } });
    expect(draftOf(form({ template: 'srv --port {port}', before: Array.from({ length: 11 }, (_, i) => `step${i}`).join('\n') })).problems).toEqual({ before: { key: 'tooMany', params: { max: 10 } } });
  });

  it('round-trips a saved engine with its commands', () => {
    const saved = customEngineSchema.parse({ id: 's', name: 'S', base: 'openai-server', run: { mode: 'command', template: 'srv --port {port} --kv {kv}', api: 'chat', before: ['a', 'b'], after: ['c'], kvTypes: ['fp8', 'auto'] } });
    const f = formOf(saved);
    expect(f).toMatchObject({ before: 'a\nb', after: 'c', kvTypes: ['auto', 'fp8'], api: 'chat' });
    // The KV types come back in precision order.
    expect(draftOf(f).draft?.run).toEqual({ ...saved.run, kvTypes: ['auto', 'fp8'] });
    expect(formOf(customEngineSchema.parse({ id: 'n', name: 'N', base: 'llamacpp', run: { mode: 'native', path: '/x' } }))).toMatchObject({ before: '', after: '', kvTypes: ['f16', 'q8_0', 'q4_0'] });
  });

  it('examples fill in the commands and keep the name', () => {
    const python = COMMAND_EXAMPLES.find((e) => e.id === 'python')!;
    expect(withExample(form({ name: 'X', before: 'old' }), python)).toMatchObject({ name: 'X', before: 'python prepare.py --model {model}', after: 'python cleanup.py', api: 'chat', kvTypes: ['f16', 'q8_0', 'q4_0'] });
    const vllm = COMMAND_EXAMPLES.find((e) => e.id === 'vllm')!;
    expect(withExample(form({ after: 'old' }), vllm)).toMatchObject({ before: '', after: '', kvTypes: ['auto', 'fp8'] });
    // Every example is a valid engine.
    for (const e of COMMAND_EXAMPLES) expect(draftOf(withExample(form(), e)).problems).toEqual({});
  });

  it('previews every command with example values, a path with spaces as one argument', () => {
    expect(sampleValues('win32', 'f16')).toMatchObject({ model: 'C:\\Models\\Qwen3 8B\\Qwen3-8B-Q4_K_M.gguf', modelDir: 'C:\\Models\\Qwen3 8B', ctx: '8192', kv: 'f16' });
    expect(sampleValues('linux', 'auto').model).toBe('/home/me/models/Qwen3 8B/Qwen3-8B-Q4_K_M.gguf');
    const f = form({ before: 'prep "{model}"', template: 'srv -m {model} --port {port} -c {ctx} --kv {kv} --name {alias}', after: 'clean --dir {modelDir}', extraArgs: '--x "a b"', kvTypes: ['q8_0'] });
    expect(commandPreview(f, 'linux', labels)).toBe(
      [
        '# before',
        'prep "/home/me/models/Qwen3 8B/Qwen3-8B-Q4_K_M.gguf"',
        '# server',
        'srv -m "/home/me/models/Qwen3 8B/Qwen3-8B-Q4_K_M.gguf" --port 8080 -c 8192 --kv q8_0 --name gpubench-3f2a9c --x "a b"',
        '# after',
        'clean --dir "/home/me/models/Qwen3 8B"',
      ].join('\n'),
    );
    // Only the server: no headings. A quote or an empty value is shown quoted too.
    expect(commandPreview(form({ template: `srv --port {port} --say 'a "b"' ""`, kvTypes: [] }), 'linux', labels)).toBe('srv --port 8080 --say "a \\"b\\"" ""');
    // Commands after only: the server gets its heading.
    expect(commandPreview(form({ template: 'srv --port {port}', after: 'bye' }), 'linux', labels)).toBe('# server\nsrv --port 8080\n# after\nbye');
    // Nothing to show while a command is wrong, or for an extra argument with an open quote.
    expect(commandPreview(form({ template: 'srv' }), 'linux', labels)).toBeUndefined();
    expect(commandPreview(form({ template: 'srv --port {port}', extraArgs: '"x' }), 'linux', labels)).toBeUndefined();
  });
});
