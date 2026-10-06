import { describe, expect, it } from 'vitest';
import { diagnoseExit, llamaPhaseOf } from '../../../../src/core/engines/llamacpp-native/logs';
import * as L from '../../../fakes/fake-engine/logs.mjs';

const c = { model: 'C:\\models\\x.gguf', host: '127.0.0.1', port: 8080, ctx: 4096, np: 1, nLayers: 33, vramMiB: 4500, flashAttn: 'auto' };
const exit1 = { code: 1, signal: null };

describe('llamaPhaseOf on the realistic startup log', () => {
  it('marks each phase once, in order', () => {
    const log = [
      ...L.llamaBanner(c),
      ...L.llamaListening(c),
      ...L.llamaModelMeta(c),
      ...L.llamaLoadTensorsStart(c),
      ...L.llamaContext(c),
      ...L.llamaWarmup(),
      ...L.llamaReady(c),
    ];
    const seen: string[] = [];
    for (const line of log) {
      const p = llamaPhaseOf(line);
      if (p !== undefined && !seen.includes(p)) seen.push(p);
    }
    expect(seen).toEqual(['model_load', 'load_tensors', 'context', 'warmup', 'listening']);
    expect(llamaPhaseOf('0.01.234.567 I load_tensors: offloaded 33/33 layers to GPU')).toBe('load_tensors');
    expect(llamaPhaseOf('srv  update_slots: all slots are idle')).toBeUndefined();
  });
});

describe('diagnoseExit', () => {
  it('CUDA OOM while loading (also says "failed to load model": OOM wins)', () => {
    const e = diagnoseExit([...L.llamaModelMeta(c), ...L.llamaLoadTensorsStart(c), ...L.llamaOom(c)], exit1);
    expect(e.code).toBe('ENGINE_OOM');
    expect(e.message).toContain('cudaMalloc failed: out of memory');
    expect(e.params).toEqual({ code: '1' });
    expect(e.detail?.split('\n').length).toBeLessThanOrEqual(25);
  });

  it('vLLM-style failures', () => {
    expect(diagnoseExit(L.vllmOom(), exit1).code).toBe('ENGINE_OOM');
    expect(diagnoseExit(L.vllmNoKernelImage(), exit1).code).toBe('ENGINE_NO_KERNEL_IMAGE');
    expect(diagnoseExit(L.vllmPortInUse(c), exit1).code).toBe('ENGINE_PORT_IN_USE');
  });

  it('rejected flags name the flag', () => {
    expect(diagnoseExit(L.llamaBadFlag('--bogus'), exit1)).toMatchObject({ code: 'ENGINE_BAD_FLAG', params: { flag: '--bogus' } });
    expect(diagnoseExit(L.llamaBadValue('-fa'), exit1)).toMatchObject({ code: 'ENGINE_BAD_FLAG', params: { flag: '-fa' } });
    expect(diagnoseExit(['error: unknown argument: --old'], exit1).params?.flag).toBe('--old');
    expect(diagnoseExit(['unknown argument: -x'], exit1).params?.flag).toBe('-x');
    expect(diagnoseExit(['error: argument -m requires a value'], exit1).params?.flag).toBe('-m');
  });

  it('port in use, missing model, spawn failure, plain exit', () => {
    expect(diagnoseExit([...L.llamaBanner(c), ...L.llamaBindFailed(c)], exit1).code).toBe('ENGINE_PORT_IN_USE');
    expect(diagnoseExit([...L.llamaModelMeta(c), ...L.llamaMissingModel(c)], exit1).code).toBe('MODEL_INVALID');
    expect(diagnoseExit(['Error: spawn C:\\llama\\llama-server.exe ENOENT'], { code: null, signal: null })).toMatchObject({
      code: 'ENGINE_START_FAILED',
      params: { code: 'null' },
    });
    expect(diagnoseExit(L.llamaCrash(), { code: null, signal: 'SIGKILL' })).toMatchObject({ code: 'ENGINE_EXITED', params: { code: 'SIGKILL' } });
    expect(diagnoseExit([], { code: 3221225477, signal: null }).message).toBe('Engine exited with 3221225477');
  });
});
