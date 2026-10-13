import { act, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { DataTable, columnHelper } from '../../../src/renderer/components/ui/data-table';
import { ScrollX } from '../../../src/renderer/components/ui/scroll-x';
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

  it('a sticky end column says when columns hide under it; a fill column takes the room left', () => {
    const wide = [
      col.accessor('name', { header: 'Modello', meta: { fill: true, className: 'min-w-48' } }),
      col.accessor('tps', { header: 'tok/s', meta: { numeric: true, stickyEnd: true } }),
    ];
    const { unmount } = renderUi(<DataTable caption="Risultati" columns={wide} data={[{ name: 'Qwen3 4B', tps: 225.5 }]} />);
    const scroller = screen.getByRole('table').parentElement!;
    // Everything fits: no fade.
    expect(scroller.dataset.more).toBeUndefined();
    expect(screen.getByRole('columnheader', { name: 'Modello' }).className).toContain('max-w-0');
    expect(screen.getByRole('cell', { name: '225.5' }).className).toContain('sticky');
    // A narrow window: columns hide on the right until the user scrolls to the end.
    Object.defineProperty(scroller, 'scrollWidth', { configurable: true, value: 900 });
    Object.defineProperty(scroller, 'clientWidth', { configurable: true, value: 600 });
    act(() => void scroller.dispatchEvent(new Event('scroll')));
    expect(scroller.dataset.more).toBe('end');
    scroller.scrollLeft = 300;
    act(() => void scroller.dispatchEvent(new Event('scroll')));
    expect(scroller.dataset.more).toBeUndefined();
    unmount();
  });
});

describe('ScrollX', () => {
  it('fades its right edge while content hides past it', () => {
    renderUi(
      <ScrollX role="region" aria-label="Confronto">
        <table>
          <tbody>
            <tr>
              <td>A</td>
            </tr>
          </tbody>
        </table>
      </ScrollX>,
    );
    const box = screen.getByRole('region', { name: 'Confronto' });
    const fade = box.nextElementSibling as HTMLElement;
    expect(fade.dataset.more).toBeUndefined();
    Object.defineProperty(box, 'scrollWidth', { configurable: true, value: 900 });
    Object.defineProperty(box, 'clientWidth', { configurable: true, value: 600 });
    act(() => void box.dispatchEvent(new Event('scroll')));
    expect(fade.dataset.more).toBe('end');
    expect(fade.className).toContain('opacity-100');
  });
});
