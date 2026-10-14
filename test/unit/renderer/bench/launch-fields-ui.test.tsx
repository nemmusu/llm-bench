/** The launch fields, the switches and "Preparati da LLM Bench" on their own: every state they can show. */
import { fireEvent, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { RunSummary } from '../../../../src/contract/results';
import { EMPTY_PARAMS_FORM, type ParamsForm } from '../../../../src/renderer/components/bench/expert-form';
import { LaunchFields } from '../../../../src/renderer/components/bench/launch-fields-panel';
import { ModelSwitches, NO_SWITCHES } from '../../../../src/renderer/components/bench/model-switches';
import { ninferSupportOf } from '../../../../src/renderer/components/bench/ninfer-support';
import { newestTune, TunePresetList } from '../../../../src/renderer/components/presets/tune-presets';
import { renderUi } from '../helpers';

beforeAll(() => {
  Object.assign(Element.prototype, { hasPointerCapture: () => false, releasePointerCapture: () => undefined, scrollIntoView: () => undefined });
});

const form = (over: Partial<ParamsForm> = {}): ParamsForm => ({ ...EMPTY_PARAMS_FORM, ...over });
const options = async (name: string) => {
  const trigger = screen.getByRole('combobox', { name });
  trigger.focus();
  fireEvent.keyDown(trigger, { key: 'Enter' });
  const list = (await screen.findAllByRole('option')).map((o) => o.textContent);
  fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
  return list;
};

describe('LaunchFields', () => {
  it('NInfer for a server: its defaults said, the fields that need another one disabled, values the build lacks kept visible', async () => {
    const gguf = ninferSupportOf({ facts: { components: ['text', 'mtp'], layouts: ['gguf_blocks_v1'] } }, ['bf16', 'int8']);
    renderUi(
      <LaunchFields
        base="ninfer"
        form={form({ ninferKvDtype: 'rk8v4', ninferSpec: 'dflash', ninferPrefixReuse: 'off', parallel: '9', ninferDraftTokens: '20' })}
        invalid={['parallel', 'ninferDraftTokens']}
        onForm={() => undefined}
        use="server"
        ninfer={gguf}
      />,
    );
    expect(screen.getByText('Da 1 a 8: NInfer serve al massimo 8 richieste insieme.')).toBeTruthy();
    expect(screen.getByText('MTP accetta da 1 a 5, DFlash da 1 a 15.')).toBeTruthy();
    expect(screen.getByText(/Questo modello non ce l’ha \(i modelli GGUF-NInfer\)\./)).toBeTruthy();
    expect(screen.getAllByText(/Solo con «Riusa il testo già letto»\./).length).toBe(3);
    expect(screen.getByText(/Vuoto: il contesto di una richiesta\./)).toBeTruthy();
    expect(screen.getByText(/Vuoto: acceso \(il valore predefinito di NInfer\)\./)).toBeTruthy();
    expect(screen.getByText(/Vuoto: bf16, quella di NInfer\./)).toBeTruthy();
    expect(await options('Tipo di cache KV')).toEqual(['Automatico', 'bf16', 'int8', 'rk8v4']);
    expect(await options('Previsione dei token')).toEqual(['Automatico', 'Nessuna', 'MTP', 'DFlash']);
  });

  it('NInfer in a test: LLM Bench’s choices said; prediction left to it; DFlash’s own draft count', () => {
    const { rerender } = renderUi(<LaunchFields base="ninfer" form={form()} invalid={[]} onForm={() => undefined} use="test" />);
    expect(screen.getByText(/Vuoto: la più precisa che entra in questa scheda/)).toBeTruthy();
    expect(screen.getByText(/Vuoto: quanti sono gli utenti del test\./)).toBeTruthy();
    expect(screen.getByText(/Vuoto: spento nei test/)).toBeTruthy();
    expect((screen.getByLabelText('Token previsti per passo') as HTMLInputElement).disabled).toBe(false);
    expect((screen.getByLabelText('Token previsti per passo') as HTMLInputElement).placeholder).toBe('3');
    rerender(<LaunchFields base="ninfer" form={form({ ninferSpec: 'dflash' })} invalid={[]} onForm={() => undefined} use="test" />);
    expect((screen.getByLabelText('Token previsti per passo') as HTMLInputElement).placeholder).toBe('7');
  });

  it('llama.cpp: the recipe’s context, YaRN in place of it, flash attention “auto”; vLLM for a server', async () => {
    const onForm = vi.fn();
    const { rerender } = renderUi(<LaunchFields base="llamacpp" form={form({ flashAttention: 'auto' })} invalid={[]} onForm={onForm} use="test" context={{ placeholder: '32.768 (dalla ricetta)', hint: 'Dalla ricetta' }} trainedContext={32_768} />);
    expect((screen.getByLabelText('Contesto (token)') as HTMLInputElement).placeholder).toBe('32.768 (dalla ricetta)');
    expect(screen.getByText('Dalla ricetta')).toBeTruthy();
    expect(screen.getByRole('combobox', { name: 'Flash attention' }).textContent).toContain('Automatico');
    await userEvent.type(screen.getByLabelText('Thread CPU'), '8');
    expect(onForm).toHaveBeenCalledWith({ threads: '8' });
    rerender(<LaunchFields base="llamacpp" form={form({ yarnTarget: '131072' })} invalid={['contextSize']} onForm={onForm} use="test" trainedContext={32_768} />);
    const ctx = screen.getByLabelText('Contesto (token)') as HTMLInputElement;
    expect([ctx.disabled, ctx.placeholder, ctx.value]).toEqual([true, '131.072 · YaRN', '']);
    expect(screen.getByText('Valore non valido: correggilo per poter avviare.')).toBeTruthy();
    rerender(<LaunchFields base="vllm" form={form()} invalid={[]} onForm={onForm} use="server" />);
    expect(screen.getByText(/Vuoto: il valore predefinito del motore\./)).toBeTruthy();
    expect((screen.getByLabelText('Memoria GPU da usare') as HTMLInputElement).placeholder).toBe('0,90');
    expect(await options('Tipo di cache KV')).toEqual(['Automatico', 'fp8']);
  });
});

describe('ModelSwitches', () => {
  it('nothing for an external server or a model with neither; NInfer’s own two', async () => {
    const onForm = vi.fn();
    const { container, rerender } = renderUi(<ModelSwitches base="external" form={NO_SWITCHES} onForm={onForm} abilities={{ vision: true, reasoning: true }} />);
    expect(container.textContent).toBe('');
    rerender(<ModelSwitches base="ninfer" form={NO_SWITCHES} onForm={onForm} abilities={{ vision: false, reasoning: false }} />);
    expect(container.textContent).toBe('');
    rerender(<ModelSwitches base="ninfer" form={NO_SWITCHES} onForm={onForm} abilities={{ vision: true, reasoning: true }} preset={{ vision: false }} />);
    expect(screen.getByText('Spento: solo testo, meno memoria video.')).toBeTruthy();
    expect(screen.getByText('Acceso: il modello ragiona prima di rispondere.')).toBeTruthy();
    await userEvent.click(screen.getByRole('switch', { name: 'Immagini' }));
    expect(onForm).toHaveBeenCalledWith({ ninferVision: 'on' });
  });
});

describe('Preparati da LLM Bench', () => {
  const summary = (id: string, createdAt: string, over: Partial<RunSummary> = {}) =>
    ({ id, createdAt, profile: 'tune', status: 'completed', engineKind: 'llamacpp-native', gpuName: 'RTX 5090', tunedCombinations: 2, ...over }) as RunSummary;

  it('the newest completed search of this engine here', () => {
    const runs = [summary('a', '2026-10-01'), summary('b', '2026-10-05'), summary('z', '2026-10-03'), summary('u', '2026-10-12', { tunedCombinations: undefined }), summary('c', '2026-10-09', { engineKind: 'vllm-docker' }), summary('d', '2026-10-10', { tunedCombinations: 0 }), summary('e', '2026-10-11', { profile: 'quick' })];
    expect(newestTune(runs, 'llamacpp-native', 'RTX 5090')?.id).toBe('b');
    expect(newestTune(runs, 'llamacpp-native', 'RTX 4090')).toBeUndefined();
  });

  it('says where they come from, an engine changed since, and each one’s numbers', async () => {
    const onUse = vi.fn();
    const params = { extraArgs: [], env: {} };
    const picks = [
      { ids: ['fastest-read' as const], combination: 1, params, kvType: 'q8_0' as const, maxContext: 32_768, depth: 1024, decodeTps: 90, prefillTps: 9000 },
      { ids: ['fastest-write' as const], combination: 2, params, kvType: 'f16' as const, maxContext: 16_384, depth: 4096, decodeTps: 95, prefillTps: 8000 },
      { ids: ['best-quality' as const], combination: 3, params, kvType: 'f16' as const, maxContext: 16_384 },
    ];
    const { rerender } = renderUi(<TunePresetList presets={{ run: summary('a', '2026-10-01T10:00:00.000Z', { engineBuild: 'b10000' }), picks }} currentBuild="b11438" onUse={onUse} />);
    expect(screen.getByText(/motore b10000\./)).toBeTruthy();
    expect(screen.getByText(/Ora il motore qui è b11438/)).toBeTruthy();
    expect(screen.getByText('Cache KV q8_0 · contesto 32K · 9.000 tok/s in lettura a 1K')).toBeTruthy();
    expect(screen.getByText('Cache KV f16 · contesto 16K · 95,0 tok/s in scrittura a 4K')).toBeTruthy();
    expect(screen.getByText('Cache KV f16 · contesto 16K')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Usa «Qualità migliore»' }));
    expect(onUse).toHaveBeenCalledWith(params, picks[2]);
    rerender(<TunePresetList presets={{ run: summary('a', '2026-10-01T10:00:00.000Z'), picks }} onUse={onUse} />);
    expect(screen.getByText(/^Dalla tua «Trova le impostazioni migliori» del [^,]*\.$/)).toBeTruthy();
  });
});

describe('LaunchFields of TensorRT-LLM', () => {
  it('shows its shared fields until its own panel words them', () => {
    renderUi(<LaunchFields base="trtllm" form={form()} invalid={[]} onForm={() => undefined} use="test" />);
    expect(screen.getByLabelText('Tipo di cache KV')).toBeTruthy();
    expect(screen.queryByLabelText('Token previsti per passo')).toBeNull();
  });
});