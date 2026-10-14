// The settings of a program with an OpenAI API in expert mode: the context typed for YaRN (another
// engine's choice) is the one shown, a wrong context is said, and its usual names in English too.
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { EMPTY_PARAMS_FORM } from '../../../../src/renderer/components/bench/expert-form';
import { CommandSettingsFields } from '../../../../src/renderer/components/engines/command-settings';
import { renderUi } from '../helpers';

const run = { template: 'srv --port {port} -c {ctx} --kv {kv}' };

describe('settings of a program', () => {
  it('shows the YaRN context it will send, says when the context is wrong, and replaces both when typed', async () => {
    const onForm = vi.fn();
    renderUi(<CommandSettingsFields run={run} form={{ ...EMPTY_PARAMS_FORM, yarnTarget: '65536', contextSize: '' }} invalid={['contextSize']} onForm={onForm} />);
    const ctx = screen.getByLabelText('Contesto (token)') as HTMLInputElement;
    expect(ctx.value).toBe('65536');
    expect(screen.getByText('Valore non valido: correggilo per poter avviare.')).toBeTruthy();
    await userEvent.type(ctx, '1');
    expect(onForm).toHaveBeenLastCalledWith({ contextSize: '655361', maxModelLen: '', yarnTarget: '', yarnOriginal: '' });
  });

  it('in English', () => {
    renderUi(<CommandSettingsFields run={run} form={{ ...EMPTY_PARAMS_FORM, kvCacheType: 'q8_0' }} invalid={[]} onForm={() => undefined} />, { lang: 'en' });
    expect(screen.getByLabelText('Context (tokens)')).toBeTruthy();
    expect(screen.getByRole('combobox', { name: 'KV cache type' }).textContent).toBe('q8_0');
    expect(screen.getByText('In place of {kv}')).toBeTruthy();
  });
});
