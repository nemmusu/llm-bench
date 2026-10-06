import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { DataTable, columnHelper } from '../../../src/renderer/components/ui/data-table';
import { renderUi } from './helpers';

interface Row {
  name: string;
  tps: number;
}

const col = columnHelper<Row>();
const columns = [col.accessor('name', { header: 'Modello' }), col.accessor('tps', { header: 'tok/s', meta: { numeric: true } })];

describe('DataTable', () => {
  it('says there is nothing to show when there are no rows', () => {
    renderUi(<DataTable caption="Risultati" columns={columns} data={[]} />);
    expect(screen.getByText('Nessuna riga da mostrare.')).toBeTruthy();
  });

  it('renders rows with the caption for screen readers', () => {
    renderUi(<DataTable caption="Risultati" columns={columns} data={[{ name: 'Qwen3 4B', tps: 225.5 }]} />);
    expect(screen.getByRole('table', { name: 'Risultati' })).toBeTruthy();
    expect(screen.getByText('Qwen3 4B')).toBeTruthy();
  });
});
