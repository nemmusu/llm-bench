import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { FitEstimate } from '../../../../src/contract/models';
import { FitSummary } from '../../../../src/renderer/components/bench/plan-card';
import { BusyVramNote } from '../../../../src/renderer/components/library/busy-note';
import { renderUi } from '../helpers';

const fit = (over: Partial<FitEstimate> = {}): FitEstimate => ({
  level: 'perfect',
  needMiB: 6000,
  weightsMiB: 4000,
  kvMiB: 1500,
  overheadMiB: 500,
  availableMiB: 31_583,
  utilization: 0.19,
  contextSize: 8192,
  basis: 'file-size',
  notes: [],
  totalMiB: 32_607,
  ...over,
});

describe('the VRAM verdict and its notes', () => {
  it('judges the card, explains how, and says why a context beyond the model or an NInfer estimate is fine', async () => {
    renderUi(<FitSummary fit={fit({ notes: ['context.rope-extended', 'ninfer.estimate'] })} />);
    expect(screen.getByText('Stima: 5,9 GB su 30,8 GB della scheda')).toBeTruthy();
    expect(screen.getByText('Contesto esteso con YaRN: oltre il limite del modello contano solo la velocità e la memoria.')).toBeTruthy();
    expect(screen.getByText('Stima approssimativa: NInfer gestisce la memoria a modo suo.')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Che cos’è «Come giudico la memoria»?' }));
    expect((await screen.findAllByText(/memoria totale della scheda \(31,8 GB\) meno 1,0 GB/)).length).toBeGreaterThan(0);
  });

  it('what the launch loads next to the model: "+ MTP 3,2 GB", "+ visione 0,9 GB"', async () => {
    renderUi(<FitSummary fit={fit({ draftMiB: 3277, mmprojMiB: 922 })} />);
    expect(screen.getByText('+ MTP 3,2 GB')).toBeTruthy();
    await userEvent.hover(screen.getByText('+ visione 0,9 GB'));
    expect((await screen.findAllByText(/caricata insieme per leggere le immagini/)).length).toBeGreaterThan(0);
  });

  it('"Ora altri programmi usano…": only when it matters, worded for a test or a server', () => {
    const { rerender } = renderUi(<BusyVramNote fit={fit({ busyMiB: 22_000, freeNowMiB: 10_607, levelNow: 'perfect' })} kind="run" />);
    expect(screen.getByText('Ora altri programmi usano 21,5 GB della scheda.')).toBeTruthy();
    expect(screen.getByText(/oppure il test partirà con meno memoria \(10,4 GB liberi adesso\)/)).toBeTruthy();
    rerender(<BusyVramNote fit={fit({ busyMiB: 2300, freeNowMiB: 30_307, levelNow: 'partial' })} kind="server" />);
    expect(screen.getByText(/oppure il server partirà con meno memoria/)).toBeTruthy();
    rerender(<BusyVramNote fit={fit({ busyMiB: 2300, freeNowMiB: 30_307, levelNow: 'perfect' })} kind="run" />);
    expect(screen.queryByRole('note')).toBeNull();
    rerender(<BusyVramNote fit={undefined} kind="run" />);
    expect(screen.queryByRole('note')).toBeNull();
  });
});
