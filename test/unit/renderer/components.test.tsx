import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { toast } from 'sonner';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Badge } from '../../../src/renderer/components/ui/badge';
import { Button, IconButton } from '../../../src/renderer/components/ui/button';
import { Callout } from '../../../src/renderer/components/ui/callout';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '../../../src/renderer/components/ui/card';
import { Checkbox } from '../../../src/renderer/components/ui/checkbox';
import { CodeBlock, defaultShellFor, tokenize } from '../../../src/renderer/components/ui/code-block';
import { ConfirmDialog, Dialog, DialogContent, DialogTrigger } from '../../../src/renderer/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '../../../src/renderer/components/ui/dropdown-menu';
import { EmptyState } from '../../../src/renderer/components/ui/empty-state';
import { FitBadge } from '../../../src/renderer/components/ui/fit-badge';
import { HelpTip } from '../../../src/renderer/components/ui/help-tip';
import { Field, Input, Label, Textarea } from '../../../src/renderer/components/ui/input';
import { Kbd } from '../../../src/renderer/components/ui/kbd';
import { Progress } from '../../../src/renderer/components/ui/progress';
import { RadialGauge } from '../../../src/renderer/components/ui/radial-gauge';
import { SegmentedControl } from '../../../src/renderer/components/ui/segmented-control';
import { Select } from '../../../src/renderer/components/ui/select';
import { Skeleton } from '../../../src/renderer/components/ui/skeleton';
import { Sparkline } from '../../../src/renderer/components/ui/sparkline';
import { StatTile } from '../../../src/renderer/components/ui/stat-tile';
import { StatusDot } from '../../../src/renderer/components/ui/status-dot';
import { Stepper } from '../../../src/renderer/components/ui/stepper';
import { Switch } from '../../../src/renderer/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../../src/renderer/components/ui/tabs';
import { Toaster } from '../../../src/renderer/components/ui/toaster';
import { Tooltip } from '../../../src/renderer/components/ui/tooltip';
import { TriedBadge } from '../../../src/renderer/components/ui/tried-badge';
import { renderUi } from './helpers';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Button', () => {
  it.each([
    ['primary', 'bg-accent-solid'],
    ['secondary', 'border-border-strong'],
    ['outline', 'bg-transparent'],
    ['ghost', 'text-fg-2'],
    ['danger', 'bg-danger-solid'],
    ['danger-outline', 'text-danger-text'],
    ['link', 'text-accent-text'],
  ] as const)('variant %s', (variant, cls) => {
    renderUi(<Button variant={variant}>Go</Button>);
    const b = screen.getByRole('button', { name: 'Go' });
    expect(b.className).toContain(cls);
    expect(b.getAttribute('type')).toBe('button');
  });

  it('xl primary gets the glow, sizes change height', () => {
    renderUi(
      <>
        <Button variant="primary" size="xl">
          Hero
        </Button>
        <Button size="sm" type="submit">
          Small
        </Button>
        <Button size="lg">Large</Button>
      </>,
    );
    expect(screen.getByRole('button', { name: 'Hero' }).className).toContain('shadow-glow');
    expect(screen.getByRole('button', { name: 'Small' }).getAttribute('type')).toBe('submit');
    expect(screen.getByRole('button', { name: 'Large' }).className).toContain('h-11');
  });

  it('asChild renders the child element with button styles', () => {
    renderUi(
      <Button asChild variant="primary">
        <a href="#/x">Link</a>
      </Button>,
    );
    const a = screen.getByRole('link', { name: 'Link' });
    expect(a.className).toContain('bg-accent-solid');
  });

  it('IconButton is named by its label and shows a tooltip', async () => {
    const onClick = vi.fn();
    renderUi(
      <>
        <IconButton label="Chiudi" icon={<svg />} onClick={onClick} />
        <IconButton label="Senza" icon={<svg />} noTooltip size="lg" variant="outline" />
      </>,
    );
    await userEvent.hover(screen.getByRole('button', { name: 'Chiudi' }));
    await waitFor(() => expect(screen.getAllByText('Chiudi').length).toBeGreaterThan(0));
    await userEvent.click(screen.getByRole('button', { name: 'Chiudi' }));
    expect(onClick).toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Senza' }).className).toContain('size-11');
  });
});

describe('Card, Badge, Kbd, Skeleton, StatusDot', () => {
  it('render their content', () => {
    const { container } = renderUi(
      <Card>
        <CardHeader>
          <CardTitle>Titolo</CardTitle>
          <CardDescription>Descrizione</CardDescription>
        </CardHeader>
        <CardContent>
          <Badge tone="success" dot>
            Ok
          </Badge>
          <Kbd>K</Kbd>
          <Skeleton className="h-4" />
          <StatusDot tone="danger" pulse />
          <StatusDot tone="neutral" />
        </CardContent>
        <CardFooter>Piede</CardFooter>
      </Card>,
    );
    expect(screen.getByRole('heading', { name: 'Titolo' })).toBeTruthy();
    expect(screen.getByText('Ok').className).toContain('bg-success-soft');
    expect(screen.getByText('K').tagName).toBe('KBD');
    expect(container.querySelectorAll('.animate-ping-soft')).toHaveLength(1);
    expect(screen.getByText('Piede')).toBeTruthy();
  });
});

describe('FitBadge', () => {
  it.each([
    ['perfect', 'Entra perfettamente', 'bg-success-soft'],
    ['good', 'Entra bene', 'bg-success-soft'],
    ['tight', 'Al limite', 'bg-warning-soft'],
    ['partial', 'Entra in parte', 'bg-warning-soft'],
    ['no', 'Non entra', 'bg-danger-soft'],
  ] as const)('%s → "%s"', (level, text, cls) => {
    renderUi(<FitBadge level={level} />);
    const badge = screen.getByText(text).closest('[data-fit]')!;
    expect(badge.getAttribute('data-fit')).toBe(level);
    expect(badge.className).toContain(cls);
  });

  it('explains the verdict on hover, with the estimate', async () => {
    renderUi(<FitBadge level="tight" detail="Stima: 30 GB" size="sm" />, { lang: 'en' });
    await userEvent.hover(screen.getByText('Tight fit'));
    await waitFor(() => expect(screen.getAllByText('Stima: 30 GB').length).toBeGreaterThan(0));
  });
});

describe('TriedBadge', () => {
  it('long and short forms', () => {
    renderUi(
      <>
        <TriedBadge tps={142.3} />
        <TriedBadge tps={58} short size="sm" date="2026-09-12T10:00:00Z" />
      </>,
    );
    expect(screen.getByText('Provato su questa GPU · 142 tok/s')).toBeTruthy();
    expect(screen.getByText('Provato · 58 tok/s')).toBeTruthy();
  });

  it('a version an update replaced says so', async () => {
    renderUi(
      <>
        <TriedBadge tps={61} previous date="2026-09-12T10:00:00Z" />
        <TriedBadge tps={61} previous short />
        <TriedBadge spilled previous date="2026-09-12T10:00:00Z" />
      </>,
    );
    expect(screen.getByText('Provato (versione precedente) · 61 tok/s')).toBeTruthy();
    expect(screen.getByText('Provato con la versione precedente: usava la RAM condivisa')).toBeTruthy();
    await userEvent.hover(screen.getByText('Provato con la versione precedente · 61 tok/s'));
    await waitFor(() => expect(screen.getAllByText(/con la versione precedente del file, prima dell’aggiornamento/).length).toBeGreaterThan(0));
  });

  it('shows the date in a tooltip', async () => {
    renderUi(<TriedBadge tps={58} date="2026-09-12T10:00:00Z" />, { lang: 'en' });
    await userEvent.hover(screen.getByText('Tried on this GPU · 58 tok/s'));
    await waitFor(() => expect(screen.getAllByText(/You measured it on Sep 12, 2026/).length).toBeGreaterThan(0));
  });
});

describe('HelpTip', () => {
  it('has a descriptive name and opens on click', async () => {
    renderUi(<HelpTip term="Generazione">Quanti token al secondo.</HelpTip>);
    const btn = screen.getByRole('button', { name: 'Che cos’è «Generazione»?' });
    await userEvent.click(btn);
    await waitFor(() => expect(screen.getAllByText('Quanti token al secondo.').length).toBeGreaterThan(0));
  });
});

describe('StatTile', () => {
  it('renders value, unit, hint, help and sparkline', () => {
    const { container } = renderUi(<StatTile label="Generazione" value="190,6" unit="tok/s" hint="512 token" help="aiuto" sparkline={[1, 2, 3]} icon={<svg />} size="lg" />);
    expect(screen.getByText('190,6').className).toContain('text-4xl');
    expect(screen.getByText('tok/s')).toBeTruthy();
    expect(screen.getByText('512 token')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Generazione/ })).toBeTruthy();
    expect(container.querySelector('polyline')).toBeTruthy();
  });

  it('colors deltas by whether the change is good', () => {
    renderUi(
      <>
        <StatTile label="A" value="1" delta={{ text: '+23%', direction: 'up', good: true, context: 'vs B' }} />
        <StatTile label="C" value="2" delta={{ text: '-5%', direction: 'down', good: false }} />
      </>,
    );
    expect(screen.getByText('+23%').className).toContain('text-success-text');
    expect(screen.getByText('vs B')).toBeTruthy();
    expect(screen.getByText('-5%').className).toContain('text-danger-text');
  });

  it('omits the footer when there is nothing to show', () => {
    const { container } = renderUi(<StatTile label="Solo" value="3" />);
    expect(container.querySelector('.mt-auto')).toBeNull();
  });
});

describe('Stepper', () => {
  it('marks states for sighted and screen-reader users', () => {
    renderUi(
      <Stepper
        label="Fasi"
        size="sm"
        stateLabels={{ done: 'Fatto', current: 'Ora', pending: 'Dopo', skipped: 'Saltato' }}
        steps={[
          { id: 'a', label: 'Uno', state: 'done' },
          { id: 'b', label: 'Due', state: 'skipped' },
          { id: 'c', label: 'Tre', state: 'current' },
          { id: 'd', label: 'Quattro', state: 'pending', icon: '★' },
          { id: 'e', label: 'Cinque', state: 'pending' },
        ]}
      />,
    );
    const list = screen.getByRole('list', { name: 'Fasi' });
    const items = within(list).getAllByRole('listitem');
    expect(items).toHaveLength(5);
    expect(items[2]!.getAttribute('aria-current')).toBe('step');
    expect(items[0]!.getAttribute('aria-current')).toBeNull();
    expect(items[0]!.textContent).toContain('Uno: Fatto');
    expect(items[1]!.textContent).toContain('Saltato');
    expect(items[3]!.textContent).toContain('★');
    expect(items[4]!.textContent).toContain('5');
  });
});

describe('CodeBlock', () => {
  const commands = { powershell: "& 'C:\\LLM Bench\\llama.exe' `\n  --port 8080", bash: "'/opt/LLM Bench/llama' \\\n  --port 8080 \"x y\"" };

  it('tokenizes programs, flags, strings and continuations', () => {
    expect(tokenize("& 'C:\\LLM Bench\\x.exe' `\n  --flag v")).toEqual([
      { text: '&', kind: 'cmd' },
      { text: ' ', kind: 'text' },
      { text: "'C:\\LLM Bench\\x.exe'", kind: 'string' },
      { text: ' ', kind: 'text' },
      { text: '`', kind: 'cont' },
      { text: '\n  ', kind: 'text' },
      { text: '--flag', kind: 'flag' },
      { text: ' ', kind: 'text' },
      { text: 'v', kind: 'text' },
    ]);
    expect(tokenize('')).toEqual([]);
    expect(tokenize("a 'unterminated").map((t) => t.kind)).toEqual(['cmd', 'text', 'string', 'text']);
  });

  it('picks the default shell from the platform', () => {
    expect(defaultShellFor('win32')).toBe('powershell');
    expect(defaultShellFor('linux')).toBe('bash');
    expect(defaultShellFor(undefined)).toBe('bash');
  });

  it('switches between PowerShell and bash', async () => {
    renderUi(<CodeBlock commands={commands} label="Comando" />);
    const code = screen.getByLabelText('Comando');
    expect(code.textContent).toContain('C:\\LLM Bench');
    await userEvent.click(screen.getByRole('radio', { name: 'bash' }));
    expect(code.textContent).toContain('/opt/LLM Bench');
  });

  it('copies the visible command and confirms', async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const success = vi.spyOn(toast, 'success');
    renderUi(<CodeBlock commands={commands} label="Comando" defaultShell="bash" />);
    await userEvent.click(screen.getByRole('button', { name: 'Copia il comando' }));
    expect(writeText).toHaveBeenCalledWith(commands.bash);
    expect(success).toHaveBeenCalledWith('Comando copiato');
    expect(screen.getByRole('button', { name: 'Comando copiato' })).toBeTruthy();
  });

  it('resets the copied state after a while', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: async () => undefined }, configurable: true });
    renderUi(<CodeBlock commands={commands} label="Comando" single />);
    expect(screen.getByText('Comando')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Copia il comando' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Comando copiato' })).toBeTruthy());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(screen.getByRole('button', { name: 'Copia il comando' })).toBeTruthy();
    vi.useRealTimers();
  });

  it('reports a failed copy', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      value: {
        writeText: async () => {
          throw new Error('denied');
        },
      },
      configurable: true,
    });
    const error = vi.spyOn(toast, 'error');
    renderUi(<CodeBlock commands={commands} label="Comando" />);
    await userEvent.click(screen.getByRole('button', { name: 'Copia il comando' }));
    expect(error).toHaveBeenCalledWith('Non sono riuscito a copiare');
  });

  it('defaults to PowerShell on Windows', () => {
    (window as { gpubench?: unknown }).gpubench = { platform: 'win32' };
    renderUi(<CodeBlock commands={commands} label="Comando" />);
    expect(screen.getByRole('radio', { name: 'PowerShell' }).getAttribute('aria-checked')).toBe('true');
    delete (window as { gpubench?: unknown }).gpubench;
  });
});

describe('Callout', () => {
  it('shows icon + title + body and runs its action', async () => {
    const onClick = vi.fn();
    renderUi(
      <>
        <Callout tone="warning" title="Attenzione" action={{ label: 'Rifai', onClick }}>
          Corpo
        </Callout>
        <Callout tone="danger" title="Errore" />
        <Callout tone="success" title="Fatto" />
        <Callout title="Info" />
      </>,
    );
    expect(screen.getAllByRole('note')).toHaveLength(4);
    expect(screen.getByText('Corpo')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Rifai' }));
    expect(onClick).toHaveBeenCalled();
  });
});

describe('EmptyState', () => {
  it.each(['results', 'search', 'downloads'] as const)('illustration %s', (kind) => {
    const { container } = renderUi(<EmptyState illustration={kind} title="Vuoto" description="Niente" action={<button type="button">Vai</button>} headingLevel={3} />);
    expect(screen.getByRole('heading', { level: 3, name: 'Vuoto' })).toBeTruthy();
    expect(container.querySelector('svg')).toBeTruthy();
  });

  it('defaults to an h2 without description or action', () => {
    renderUi(<EmptyState title="Solo titolo" />);
    expect(screen.getByRole('heading', { level: 2, name: 'Solo titolo' })).toBeTruthy();
  });
});

describe('Progress', () => {
  it('clamps and labels the value', () => {
    renderUi(
      <>
        <Progress value={150} label="Avanzamento" valueText="100%" />
        <Progress value={-3} label="Altro" tone="danger" size="sm" />
      </>,
    );
    const bar = screen.getByRole('progressbar', { name: 'Avanzamento' });
    expect(bar.getAttribute('aria-valuenow')).toBe('100');
    expect(bar.getAttribute('aria-valuetext')).toBe('100%');
    expect(screen.getByRole('progressbar', { name: 'Altro' }).getAttribute('aria-valuenow')).toBe('0');
  });
});

describe('RadialGauge', () => {
  it('exposes a meter with text value', () => {
    renderUi(<RadialGauge value={190.6} max={250} label="Generazione" unit="tok/s" format={(v) => v.toFixed(1)} help="aiuto" />);
    const meter = screen.getByRole('meter', { name: 'Generazione' });
    expect(meter.getAttribute('aria-valuenow')).toBe('190.6');
    expect(meter.getAttribute('aria-valuetext')).toBe('190.6 tok/s');
    expect(meter.querySelectorAll('path')).toHaveLength(2);
  });

  it('turns warning and danger above thresholds, hides the arc at zero', () => {
    const { container } = renderUi(
      <>
        <RadialGauge value={82} max={100} label="T1" unit="°C" format={String} warnAt={0.8} dangerAt={0.9} caption="cap" />
        <RadialGauge value={95} max={100} label="T2" unit="°C" format={String} warnAt={0.8} dangerAt={0.9} />
        <RadialGauge value={0} max={100} label="T3" unit="W" format={String} />
      </>,
    );
    const strokes = [...container.querySelectorAll('path')].map((p) => p.getAttribute('stroke'));
    expect(strokes).toContain('var(--warning)');
    expect(strokes).toContain('var(--danger)');
    expect(screen.getByRole('meter', { name: 'T3' }).querySelectorAll('path')).toHaveLength(1);
    expect(screen.getByText('cap')).toBeTruthy();
  });
});

describe('Sparkline', () => {
  it('needs at least two points', () => {
    const { container } = renderUi(<Sparkline values={[1]} />);
    expect(container.querySelector('svg')).toBeNull();
  });

  it('draws a flat line and an optional end dot', () => {
    const { container } = renderUi(
      <>
        <Sparkline values={[5, 5, 5]} endDot={false} />
        <Sparkline values={[1, 3]} color="red" />
      </>,
    );
    expect(container.querySelectorAll('polyline')).toHaveLength(2);
    expect(container.querySelectorAll('circle')).toHaveLength(1);
  });
});

describe('SegmentedControl', () => {
  it('segments behave as a radio group', async () => {
    const onChange = vi.fn();
    renderUi(
      <SegmentedControl
        label="Durata"
        value="a"
        onValueChange={onChange}
        size="lg"
        fullWidth
        options={[
          { value: 'a', label: 'A', sublabel: '1 min', icon: <svg /> },
          { value: 'b', label: 'B' },
          { value: 'c', label: 'C', disabled: true },
        ]}
      />,
    );
    const group = screen.getByRole('radiogroup', { name: 'Durata' });
    expect(within(group).getAllByRole('radio')).toHaveLength(3);
    await userEvent.click(screen.getByRole('radio', { name: 'B' }));
    expect(onChange).toHaveBeenCalledWith('b');
  });

  it('list layout shows the sublabel on the right', async () => {
    const onChange = vi.fn();
    renderUi(
      <SegmentedControl
        label="Profilo"
        layout="list"
        value="x"
        onValueChange={onChange}
        options={[
          { value: 'x', label: 'Rapido', sublabel: '~2 min' },
          { value: 'y', label: 'Completo', icon: <svg />, disabled: true },
          { value: 'z', label: 'Standard' },
        ]}
      />,
    );
    expect(screen.getByText('~2 min')).toBeTruthy();
    await userEvent.click(screen.getByRole('radio', { name: 'Standard' }));
    expect(onChange).toHaveBeenCalledWith('z');
  });

  it('small segments', () => {
    renderUi(<SegmentedControl label="S" size="sm" value="a" onValueChange={() => undefined} options={[{ value: 'a', label: 'A' }]} />);
    expect(screen.getByRole('radio', { name: 'A' }).className).toContain('h-6');
  });
});

describe('Form controls', () => {
  it('Field wires label, hint and control', () => {
    renderUi(
      <Field label="Contesto" hint="In token" aside={<span>?</span>}>
        {({ id, describedBy }) => <Input id={id} aria-describedby={describedBy} defaultValue="8192" />}
      </Field>,
    );
    const input = screen.getByLabelText('Contesto');
    expect((input as HTMLInputElement).value).toBe('8192');
    expect(document.getElementById(input.getAttribute('aria-describedby')!)!.textContent).toBe('In token');
  });

  it('Field without hint, Textarea and Label', () => {
    renderUi(
      <>
        <Field label="Note">{({ id, describedBy }) => <Textarea id={id} aria-describedby={describedBy} />}</Field>
        <Label>Etichetta</Label>
      </>,
    );
    expect(screen.getByLabelText('Note').tagName).toBe('TEXTAREA');
    expect(screen.getByLabelText('Note').getAttribute('aria-describedby')).toBeNull();
    expect(screen.getByText('Etichetta')).toBeTruthy();
  });

  it('Switch and Checkbox toggle', async () => {
    const onSwitch = vi.fn();
    const onCheck = vi.fn();
    renderUi(
      <>
        <Switch aria-label="Esperto" onCheckedChange={onSwitch} />
        <Checkbox aria-label="Accetto" onCheckedChange={onCheck} />
      </>,
    );
    await userEvent.click(screen.getByRole('switch', { name: 'Esperto' }));
    await userEvent.click(screen.getByRole('checkbox', { name: 'Accetto' }));
    expect(onSwitch).toHaveBeenCalledWith(true);
    expect(onCheck).toHaveBeenCalledWith(true);
  });

  it('Select shows the current value and accessible name', () => {
    renderUi(
      <Select
        aria-label="Motore"
        value="b"
        onValueChange={() => undefined}
        options={[
          { value: 'a', label: 'Alfa', description: 'desc', text: 'Alfa' },
          { value: 'b', label: 'Beta', disabled: true },
        ]}
        disabled
      />,
    );
    const trigger = screen.getByRole('combobox', { name: 'Motore' });
    expect(trigger.textContent).toContain('Beta');
  });
});

describe('Tabs, Tooltip, Dialogs, Menus, Toaster', () => {
  it('Tabs switch panels', async () => {
    renderUi(
      <Tabs defaultValue="a">
        <TabsList>
          <TabsTrigger value="a">Uno</TabsTrigger>
          <TabsTrigger value="b">Due</TabsTrigger>
        </TabsList>
        <TabsContent value="a">Pannello uno</TabsContent>
        <TabsContent value="b">Pannello due</TabsContent>
      </Tabs>,
    );
    expect(screen.getByText('Pannello uno')).toBeTruthy();
    await userEvent.click(screen.getByRole('tab', { name: 'Due' }));
    expect(screen.getByText('Pannello due')).toBeTruthy();
  });

  it('Tooltip can be controlled', () => {
    renderUi(
      <Tooltip content="Suggerimento" open side="right" align="start" onOpenChange={() => undefined}>
        <button type="button">T</button>
      </Tooltip>,
    );
    expect(screen.getAllByText('Suggerimento').length).toBeGreaterThan(0);
  });

  it('Dialog shows title, description, body and footer', async () => {
    renderUi(
      <Dialog>
        <DialogTrigger asChild>
          <button type="button">Apri</button>
        </DialogTrigger>
        <DialogContent title="Titolo" description="Spiegazione" footer={<button type="button">Ok</button>} size="xl">
          Corpo
        </DialogContent>
      </Dialog>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Apri' }));
    const dialog = screen.getByRole('dialog', { name: 'Titolo' });
    expect(within(dialog).getByText('Spiegazione')).toBeTruthy();
    expect(within(dialog).getByText('Corpo')).toBeTruthy();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Chiudi' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('Dialog without description or footer', () => {
    renderUi(
      <Dialog open>
        <DialogContent title="Solo titolo" />
      </Dialog>,
    );
    expect(screen.getByRole('dialog', { name: 'Solo titolo' })).toBeTruthy();
  });

  it('ConfirmDialog confirms and cancels', async () => {
    const onConfirm = vi.fn();
    const onOpenChange = vi.fn();
    renderUi(<ConfirmDialog open onOpenChange={onOpenChange} title="Sicuro?" description="Davvero" confirmLabel="Sì" cancelLabel="No" onConfirm={onConfirm} tone="primary" />);
    const dialog = screen.getByRole('alertdialog', { name: 'Sicuro?' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Sì' }));
    expect(onConfirm).toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('DropdownMenu lists items', async () => {
    const onSelect = vi.fn();
    renderUi(
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button type="button">Menu</button>
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuLabel>Formati</DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={onSelect}>CSV</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Menu' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'CSV' }));
    expect(onSelect).toHaveBeenCalled();
  });

  it('Toaster renders toasts', async () => {
    renderUi(<Toaster theme="dark" />);
    act(() => {
      toast('Ciao');
    });
    expect(await screen.findByText('Ciao')).toBeTruthy();
  });
});
