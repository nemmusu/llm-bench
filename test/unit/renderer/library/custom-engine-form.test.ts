import { describe, expect, it } from 'vitest';
import { CUSTOM_ENGINE_TEMPLATES, customEngineSchema } from '../../../../src/contract/custom-engines';
import { draftOf, EMPTY_FORM, formOf, formOfTemplate, modeFor } from '../../../../src/renderer/components/engines/custom-engine-form';
import { validateEnginesSearch } from '../../../../src/renderer/routes/engines';

const form = (o: Partial<typeof EMPTY_FORM> = {}) => ({ ...EMPTY_FORM, ...o });

describe('custom engine form', () => {
  it('builds the draft of a llama.cpp fork with its options', () => {
    const { draft, problems } = draftOf(
      form({ name: ' PrismML ', path: ' /prism/llama-server ', extraArgs: '--ternary-kernels on --tag "a b"', env: 'LD_LIBRARY_PATH=/prism/lib\n\n A_B = x ', names: 'bonsai, ', quants: 'PQ2_0,PTQ1_0', notes: ' note ' }),
    );
    expect(problems).toEqual({});
    expect(draft).toEqual({
      name: 'PrismML',
      base: 'llamacpp',
      run: { mode: 'native', path: '/prism/llama-server' },
      extraArgs: ['--ternary-kernels', 'on', '--tag', 'a b'],
      env: { LD_LIBRARY_PATH: '/prism/lib', A_B: 'x' },
      notes: 'note',
      match: { names: ['bonsai'], quants: ['PQ2_0', 'PTQ1_0'] },
    });
    expect(draftOf(form({ name: 'x', path: 'p' })).draft).not.toHaveProperty('match');
  });

  it('a NInfer variant: its build, its distro, its repository', () => {
    const tpl = CUSTOM_ENGINE_TEMPLATES.find((t) => t.id === 'ninfer-all')!;
    const fromTemplate = formOfTemplate(tpl, 'NInfer-all');
    expect(fromTemplate).toMatchObject({ base: 'ninfer', mode: 'ninfer', repoUrl: 'https://github.com/iamwavecut/ninfer-all.git', branch: 'master', names: 'GGUF-NInfer', templateId: 'ninfer-all' });
    expect(draftOf({ ...fromTemplate, path: '/home/u/ninfer-all', distro: 'Ubuntu-24.04' }).draft?.run).toEqual({
      mode: 'ninfer',
      path: '/home/u/ninfer-all',
      distro: 'Ubuntu-24.04',
      source: { url: 'https://github.com/iamwavecut/ninfer-all.git', branch: 'master' },
    });
    // No distro (Linux), no repository: just where it is.
    expect(draftOf(form({ base: 'ninfer', mode: 'ninfer', name: 'n', path: '/opt/n' })).draft?.run).toEqual({ mode: 'ninfer', path: '/opt/n' });
    expect(draftOf(form({ base: 'ninfer', mode: 'ninfer', name: 'n', path: '/opt/n', repoUrl: 'https://x.org/n.git', branch: ' ' })).draft?.run).toEqual({ mode: 'ninfer', path: '/opt/n', source: { url: 'https://x.org/n.git' } });
    // Not a repository, a branch that is an option, no path.
    expect(draftOf(form({ base: 'ninfer', mode: 'ninfer', name: 'n', repoUrl: 'ftp://x', branch: '-b' })).problems).toEqual({ path: { key: 'required' }, repoUrl: { key: 'badRepo' }, branch: { key: 'badBranch' } });
    // Edited: the form of a saved variant, with and without its repository and distro.
    const saved = customEngineSchema.parse({ id: 'v', name: 'V', base: 'ninfer', run: { mode: 'ninfer', path: '/p', distro: 'Debian', source: { url: 'https://github.com/a/b.git', branch: 'dev' } } });
    expect(formOf(saved)).toMatchObject({ mode: 'ninfer', path: '/p', distro: 'Debian', repoUrl: 'https://github.com/a/b.git', branch: 'dev' });
    expect(formOf(customEngineSchema.parse({ id: 'w', name: 'W', base: 'ninfer', run: { mode: 'ninfer', path: '/q' } }))).toMatchObject({ distro: '', repoUrl: '', branch: '' });
    expect(modeFor('ninfer', 'native')).toBe('ninfer');
    expect(modeFor('llamacpp', 'ninfer')).toBe('native');
  });

  it('a Docker image, a command template and its API', () => {
    expect(draftOf(form({ base: 'sglang', mode: 'docker', name: 's', image: 'me/sglang:1', templateId: 't' })).draft).toMatchObject({ run: { mode: 'docker', image: 'me/sglang:1' }, template: 't' });
    expect(draftOf(form({ base: 'openai-server', mode: 'native', name: 'o', template: 'srv --port {port}', api: 'chat' })).draft?.run).toEqual({ mode: 'command', template: 'srv --port {port}', api: 'chat' });
  });

  it('says what is missing or wrong', () => {
    expect(draftOf(form()).problems).toEqual({ name: { key: 'required' }, path: { key: 'required' } });
    expect(draftOf(form({ name: 'x', mode: 'docker' })).problems).toEqual({ image: { key: 'required' } });
    expect(draftOf(form({ name: 'x', mode: 'docker', image: '-bad image' })).problems).toEqual({ image: { key: 'badImage' } });
    expect(draftOf(form({ name: 'x', path: 'p', extraArgs: '"open' })).problems.extraArgs).toEqual({ key: 'templateProblems.unbalanced_quote' });
    expect(draftOf(form({ name: 'x', path: 'p', env: 'OK=1\nnot a var' })).problems.env).toEqual({ key: 'envInvalid', params: { line: 2 } });
    expect(draftOf(form({ name: 'x', path: 'p', names: '/(/' })).problems.names).toEqual({ key: 'badPattern' });
    const cmd = (template: string) => draftOf(form({ base: 'openai-server', name: 'o', template })).problems.template;
    expect(cmd('')).toEqual({ key: 'templateProblems.empty' });
    expect(cmd('srv --model {model}')).toEqual({ key: 'templateProblems.port_missing' });
    expect(cmd('srv --port {port} --x {nope}')).toEqual({ key: 'templateProblems.unknown_placeholder', params: { names: '{nope}' } });
    expect(cmd('{model} --port {port}')).toEqual({ key: 'templateProblems.program_placeholder' });
  });

  it('round-trips a saved engine and fills a template', () => {
    const saved = customEngineSchema.parse({
      id: 'f',
      name: 'F',
      base: 'llamacpp',
      run: { mode: 'native', path: '/x' },
      extraArgs: ['--a', 'b c', 'say "hi"'],
      env: { A: '1' },
      match: { names: ['bonsai'], quants: [] },
      template: 'prismml-bonsai',
    });
    const f = formOf(saved);
    expect(f).toMatchObject({ extraArgs: `--a "b c" 'say "hi"'`, env: 'A=1', names: 'bonsai', quants: '', templateId: 'prismml-bonsai' });
    expect(draftOf(f).draft).toMatchObject({ extraArgs: ['--a', 'b c', 'say "hi"'], env: { A: '1' } });
    expect(formOf(customEngineSchema.parse({ id: 'd', name: 'D', base: 'vllm', run: { mode: 'docker', image: 'i:1' } }))).toMatchObject({ mode: 'docker', image: 'i:1', path: '', names: '' });
    expect(formOf(customEngineSchema.parse({ id: 'c', name: 'C', base: 'openai-server', run: { mode: 'command', template: 't {port}', api: 'chat' } }))).toMatchObject({ mode: 'command', template: 't {port}', api: 'chat' });
    expect(formOfTemplate(CUSTOM_ENGINE_TEMPLATES[0]!, 'Fork PrismML')).toMatchObject({ base: 'llamacpp', name: 'Fork PrismML', names: 'bonsai', quants: 'PQ2_0, PTQ1_0', templateId: 'prismml-bonsai' });
    expect(modeFor('openai-server', 'docker')).toBe('command');
    expect(modeFor('vllm', 'command')).toBe('native');
    expect(modeFor('sglang', 'docker')).toBe('docker');
  });
});

describe('/engines search', () => {
  it('keeps a known template and the model that asked for it', () => {
    expect(validateEnginesSearch({ customTemplate: 'prismml-bonsai', model: 'w', modelName: ' Bonsai 8B ' })).toEqual({ customTemplate: 'prismml-bonsai', model: 'w', modelName: 'Bonsai 8B' });
    expect(validateEnginesSearch({ customTemplate: 'nope', model: 3, modelName: '' })).toEqual({});
    expect(validateEnginesSearch({})).toEqual({});
  });
});
