/**
 * Boot code and UI pieces exercised with unusual input.
 */
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderUi } from './helpers';
import { Select } from '../../../src/renderer/components/ui/select';

vi.mock('echarts/core', () => ({ use: vi.fn(), init: vi.fn(() => ({ setOption: vi.fn(), resize: vi.fn(), dispose: vi.fn() })) }));
vi.mock('echarts/charts', () => ({ LineChart: {}, BarChart: {} }));
vi.mock('echarts/components', () => ({
  AxisPointerComponent: {},
  DataZoomComponent: {},
  GridComponent: {},
  LegendComponent: {},
  MarkAreaComponent: {},
  MarkLineComponent: {},
  TooltipComponent: {},
}));
vi.mock('echarts/renderers', () => ({ CanvasRenderer: {} }));

afterEach(() => {
  vi.restoreAllMocks();
});

describe('boot', () => {
  it('mounts the app into #root and refuses a page without it', async () => {
    document.body.innerHTML = '<div id="root"></div>';
    window.history.replaceState(null, '', '/?token=t#/');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 500 }));
    const { boot } = await import('../../../src/renderer/main');
    await waitFor(() => expect(document.getElementById('root')!.childElementCount).toBeGreaterThan(0));
    const empty = document.implementation.createHTMLDocument('x');
    await expect(boot(empty)).rejects.toThrow('#root missing');
    // The booted app stays mounted on its own root: detach it so later tests start clean.
    document.body.innerHTML = '';
  });
});

describe('Select', () => {
  it('opens and picks an option', async () => {
    Object.assign(Element.prototype, { hasPointerCapture: () => false, releasePointerCapture: () => undefined, scrollIntoView: () => undefined });
    const onChange = vi.fn();
    renderUi(
      <Select
        aria-label="Lingua"
        value="it"
        onValueChange={onChange}
        options={[
          { value: 'it', label: 'Italiano' },
          { value: 'en', label: 'English', description: 'Inglese' },
        ]}
      />,
    );
    const trigger = screen.getByRole('combobox', { name: 'Lingua' });
    trigger.focus();
    fireEvent.keyDown(trigger, { key: 'Enter' });
    const option = await screen.findByRole('option', { name: /English/ });
    fireEvent.keyDown(option, { key: 'Enter' });
    fireEvent.click(option);
    await waitFor(() => expect(onChange).toHaveBeenCalledWith('en'));
  });
});

// Setup & library screens with unusual data: test/unit/renderer/library/**.
