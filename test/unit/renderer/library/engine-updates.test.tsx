import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { customEngineSchema, type CustomEngine } from '../../../../src/contract/custom-engines';
import type { EngineUpdateCheck } from '../../../../src/contract/engine-updates';
import { installLabel } from '../../../../src/renderer/components/library/downloads-panel';
import { commandLine, updateHeadline } from '../../../../src/renderer/components/engines/engine-update';
import { InstallProgress } from '../../../../src/renderer/components/setup/install-progress';
import { createFormatters } from '../../../../src/renderer/i18n';
import { renderUi } from '../helpers';
import { bridge, customCheck, customInfo, ENGINES, fail, item, libApi, renderLib, report, system, world } from './fake';

vi.mock('echarts/core', () => ({ use: vi.fn(), init: vi.fn(() => ({ setOption: vi.fn(), resize: vi.fn(), dispose: vi.fn() })) }));
vi.mock('echarts/charts', () => ({ LineChart: {}, BarChart: {} }));
vi.mock('echarts/components', () => ({ AxisPointerComponent: {}, DataZoomComponent: {}, GridComponent: {}, LegendComponent: {}, MarkAreaComponent: {}, MarkLineComponent: {}, TooltipComponent: {} }));
vi.mock('echarts/renderers', () => ({ CanvasRenderer: {} }));

afterEach(() => {
  delete (window as { gpubench?: unknown }).gpubench;
  vi.restoreAllMocks();
});

const f = createFormatters('it');
const at = '2026-10-13T10:00:00.000Z';
const upd = (o: Partial<EngineUpdateCheck> & Pick<EngineUpdateCheck, 'target' | 'method' | 'state'>): EngineUpdateCheck => ({ commands: [], checkedAt: at, ...o });
const card = (name: string) => screen.findByRole('region', { name });
const linux = system({ os: { platform: 'linux', release: '6', arch: 'x64', name: 'Ubuntu 24.04', isWsl: false } });
const engine = (o: Partial<CustomEngine> & Pick<CustomEngine, 'id' | 'name' | 'base' | 'run'>): CustomEngine => customEngineSchema.parse(o);

describe('Aggiorna of a NInfer fork of the user\'s (its own card, in a WSL distro)', () => {
  it('7 new commits (5 shown), the commands and the way back inside its distro; a rebuild only when its program is older; a failed one says whether the old build is back', async () => {
    bridge();
    const fusion = engine({ id: 'fusion', name: 'Fusion', base: 'ninfer', run: { mode: 'ninfer', path: '/home/u/fusion', distro: 'Ubuntu-24.04', source: { url: 'https://github.com/someone/ninfer-fusion.git' } } });
    const w = world({ settings: { ...world().settings, customEngines: [fusion] } });
    w.custom = [customInfo(fusion, customCheck({ kind: 'ninfer-wsl', status: { kind: 'ninfer-wsl', available: true, installed: true, version: 'a1b2c3d4e5f6', problems: [], supported: true }, flagCount: 40, missing: [] }))];
    const base = { target: 'custom:fusion', method: 'git' as const, repo: '/home/u/fusion', current: 'a1b2c3d', latest: 'e4f5a6b', distro: 'Ubuntu-24.04' };
    const log = Array.from({ length: 7 }, (_, i) => ({ sha: `c${i}c${i}c${i}c`, title: `commit ${i + 1}` }));
    w.updates['custom:fusion'] = upd({
      ...base,
      state: 'available',
      commits: 7,
      log,
      commands: [
        ['git', '-C', '/home/u/fusion', 'pull', '--ff-only'],
        ['cmake', '--build', '/home/u/fusion/build', '-j'],
      ],
      restore: [['git', '-C', '/home/u/fusion', 'reset', '--hard', 'a1b2c3d']],
    });
    const api = libApi(w);
    renderLib('/engines', api);
    const c = await card('Fusion');
    expect(await within(c).findByText('7 commit nuovi: a1b2c3d → e4f5a6b')).toBeTruthy();
    expect(within(c).getByText('commit 5')).toBeTruthy();
    expect(within(c).queryByText('commit 6')).toBeNull();
    expect(within(c).getByText('e altri 2')).toBeTruthy();
    await userEvent.click(within(c).getByRole('button', { name: 'Aggiorna' }));
    const dialog = await screen.findByRole('dialog', { name: 'Aggiornare Fusion?' });
    expect(within(dialog).getByText(/Tutto succede dentro Ubuntu-24\.04, solo in questa cartella\./)).toBeTruthy();
    expect(within(dialog).getByRole('region', { name: 'Per tornare com’era' }).textContent).toContain('git -C /home/u/fusion reset --hard a1b2c3d');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Annulla' }));
  });

  it('pulled by hand, not rebuilt: only a rebuild, without downloading anything; a failed one says whether the old build is back', async () => {
    bridge();
    const fusion = engine({ id: 'fusion', name: 'Fusion', base: 'ninfer', run: { mode: 'ninfer', path: '/home/u/fusion', distro: 'Ubuntu-24.04' } });
    const w = world({ settings: { ...world().settings, customEngines: [fusion] } });
    w.custom = [customInfo(fusion, customCheck({ kind: 'ninfer-wsl', status: { kind: 'ninfer-wsl', available: true, installed: true, version: 'a1b2c3d4e5f6', problems: [], supported: true }, flagCount: 40, missing: [] }))];
    w.updates['custom:fusion'] = upd({ target: 'custom:fusion', method: 'git', repo: '/home/u/fusion', current: 'a1b2c3d', latest: 'a1b2c3d', state: 'available', stale: true, commits: 0, log: [], commands: [['cmake', '--build', '/home/u/fusion/build', '-j']] });
    const api = libApi(w);
    renderLib('/engines', api);
    const c = await card('Fusion');
    expect(await within(c).findByText('Il codice è più nuovo della build: ricompila')).toBeTruthy();
    await userEvent.click(within(c).getByRole('button', { name: 'Ricompila' }));
    const rebuild = await screen.findByRole('dialog', { name: 'Aggiornare Fusion?' });
    expect(within(rebuild).getByText(/Ricompilo il motore in \/home\/u\/fusion con il codice che c’è già/)).toBeTruthy();
    await userEvent.click(within(rebuild).getByRole('button', { name: 'Ricompila' }));
    await waitFor(() => expect(api.calls.some((x) => x.method === 'POST' && x.path === '/api/engines/custom/fusion/update')).toBe(true));
    // It stops: the build of before is back (or not).
    act(() => api.emit({ type: 'engine.install', kind: 'update:custom:fusion', stage: 'error', bytesDone: 0, error: { code: 'ENGINE_UPDATE_FAILED', message: 'x', params: { reason: 'cmake', restored: true, commit: 'a1b2c3d' } } }));
    expect(await within(c).findByText('La compilazione non è riuscita: ho rimesso la versione di prima (a1b2c3d), funziona come prima.')).toBeTruthy();
    act(() => api.emit({ type: 'engine.install', kind: 'update:custom:fusion', stage: 'error', bytesDone: 0, error: { code: 'ENGINE_UPDATE_FAILED', message: 'x', params: { reason: 'cmake', restored: true } } }));
    expect(await within(c).findByText('La compilazione non è riuscita: ho rimesso la versione di prima (), funziona come prima.')).toBeTruthy();
    act(() => api.emit({ type: 'engine.install', kind: 'update:custom:fusion', stage: 'error', bytesDone: 0, error: { code: 'ENGINE_UPDATE_FAILED', message: 'x', params: { reason: 'cmake', restored: false } } }));
    expect(await within(c).findByText('Non sono riuscito a rimettere la versione di prima: ricompila il motore.')).toBeTruthy();
  });
});

describe('Aggiorna on the engine cards', () => {
  it('SGLang in Docker: a newer release with its size, the exact command, the update with its progress', async () => {
    bridge();
    const engines = [...ENGINES(), { kind: 'sglang-docker' as const, available: true, installed: true, problems: [], supported: true }];
    const w = world({ engines });
    w.updates['sglang-docker'] = upd({
      target: 'sglang-docker',
      method: 'docker-tag',
      state: 'available',
      current: 'v0.5.21',
      latest: 'v0.5.22',
      sizeBytes: 9.8 * 1024 ** 3,
      image: 'lmsysorg/sglang:v0.5.22',
      commands: [['docker', 'pull', 'lmsysorg/sglang:v0.5.22']],
    });
    const api = libApi(w);
    renderLib('/engines', api);
    const c = await card('SGLang (Docker)');
    expect(await within(c).findByText('Aggiornamento disponibile: v0.5.21 → v0.5.22 · 9,8 GB')).toBeTruthy();
    await userEvent.click(within(c).getByRole('button', { name: 'Aggiorna' }));
    const dialog = await screen.findByRole('dialog', { name: 'Aggiornare SGLang (Docker)?' });
    expect(within(dialog).getByText(/Scarico lmsysorg\/sglang:v0\.5\.22 e lo scelgo per i prossimi test\. v0\.5\.21 resta sul PC/)).toBeTruthy();
    expect(within(dialog).getByRole('region', { name: 'Comandi che eseguo' }).textContent).toContain('docker pull lmsysorg/sglang:v0.5.22');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Aggiorna' }));
    await waitFor(() => expect(api.calls.some((x) => x.method === 'POST' && x.path === '/api/engines/sglang-docker/update')).toBe(true));
    act(() => api.emit({ type: 'engine.install', kind: 'update:sglang-docker', label: 'SGLang (Docker)', stage: 'download', bytesDone: 1e9, bytesTotal: 2e9 }));
    expect(await within(c).findByRole('progressbar', { name: 'Aggiornamento di SGLang (Docker)' })).toBeTruthy();
    w.updates['sglang-docker'] = upd({ target: 'sglang-docker', method: 'docker-pull', state: 'current', current: 'v0.5.22' });
    act(() => api.emit({ type: 'engine.install', kind: 'update:sglang-docker', label: 'SGLang (Docker)', stage: 'done', bytesDone: 0, result: { version: 'v0.5.22' } }));
    expect(await within(c).findByText('Aggiornato a v0.5.22')).toBeTruthy();
    // The check is read again: now up to date.
    expect(await within(c).findByText('Hai l’ultima versione (v0.5.22)')).toBeTruthy();
  });

  it('vLLM in Docker and installed with uv; nothing checked while Docker is off', async () => {
    bridge({ platform: 'linux' });
    const engines = ENGINES().map((e) => (e.kind === 'vllm-native' ? { ...e, available: true, installed: true, supported: true, version: '0.11.0' } : e));
    const w = world({ system: linux, engines, check: report([item('vllm-native', { state: 'ok' })]) });
    w.updates['vllm-native'] = upd({ target: 'vllm-native', method: 'uv', state: 'available', current: '0.11.0', latest: '0.11.2', commands: [['uv', 'pip', 'install', 'vllm==0.11.2', '--torch-backend', 'auto']] });
    w.updates['vllm-docker'] = upd({ target: 'vllm-docker', method: 'docker-pull', state: 'available', current: 'v0.11.0', latest: 'v0.11.0', sizeBytes: 8 * 1024 ** 3 });
    const api = libApi(w);
    renderLib('/engines', api);
    const native = await card('vLLM (Linux)');
    expect(await within(native).findByText('Aggiornamento disponibile: 0.11.0 → 0.11.2')).toBeTruthy();
    await userEvent.click(within(native).getByRole('button', { name: 'Aggiorna' }));
    const dialog = await screen.findByRole('dialog', { name: 'Aggiornare vLLM (Linux)?' });
    expect(within(dialog).getByText(/Aggiorno vLLM \(Linux\) da 0\.11\.0 a 0\.11\.2 nel suo ambiente/)).toBeTruthy();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Annulla' }));
    expect(api.calls.some((x) => x.method === 'POST' && x.path.endsWith('/update'))).toBe(false);
    expect(await within(await card('vLLM (Docker)')).findByText('C’è una versione più nuova di v0.11.0 · 8,0 GB')).toBeTruthy();

    document.body.innerHTML = '';
    const off = libApi(world({ docker: { state: 'stopped' } }));
    renderLib('/engines', off);
    await card('vLLM (Docker)');
    expect(off.calls.some((x) => x.path === '/api/engines/vllm-docker/update')).toBe(false);
  });

  it('a fork in a git checkout: new commits, the commands shown first; asked again it finds changes of yours', async () => {
    bridge();
    const prism = engine({ id: 'prismml', name: 'PrismML', base: 'llamacpp', run: { mode: 'native', path: 'C:\\src\\prism ml\\build\\bin\\Release\\llama-server.exe' } });
    const w = world({ settings: { ...world().settings, customEngines: [prism] } });
    w.custom = [customInfo(prism)];
    const base = { target: 'custom:prismml', method: 'git' as const, repo: 'C:\\src\\prism ml', buildDir: 'C:\\src\\prism ml\\build', current: 'a1b2c3d', latest: 'e4f5a6b', branch: 'master' };
    w.updates['custom:prismml'] = upd({
      ...base,
      state: 'available',
      commits: 3,
      commands: [
        ['git', '-C', 'C:\\src\\prism ml', 'pull', '--ff-only'],
        ['cmake', '--build', 'C:\\src\\prism ml\\build', '-j', '--config', 'Release'],
      ],
    });
    w.updates['custom:prismml?fetch'] = upd({ ...base, state: 'blocked', reason: 'dirty', changed: 2 });
    const api = libApi(w);
    renderLib('/engines', api);
    const c = await card('PrismML');
    expect(await within(c).findByText('3 commit nuovi: a1b2c3d → e4f5a6b')).toBeTruthy();
    await userEvent.click(within(c).getByRole('button', { name: 'Aggiorna' }));
    const dialog = await screen.findByRole('dialog', { name: 'Aggiornare PrismML?' });
    expect(within(dialog).getByText(/Scarico i commit nuovi in C:\\src\\prism ml e ricompilo il motore/)).toBeTruthy();
    const code = within(dialog).getByRole('region', { name: 'Comandi che eseguo' }).textContent;
    expect(code).toContain('git -C "C:\\src\\prism ml" pull --ff-only');
    expect(code).toContain('cmake --build "C:\\src\\prism ml\\build" -j --config Release');
    await userEvent.keyboard('{Escape}');
    // "Controlla aggiornamenti" is offered once it is up to date or blocked: here, the remote asked again.
    w.updates['custom:prismml'] = upd({ ...base, state: 'current' });
    api.emit({ type: 'engine.install', kind: 'update:custom:prismml', stage: 'error', bytesDone: 0, error: { code: 'ENGINE_UPDATE_FAILED', message: 'cmake failed', params: { reason: 'cmake' } } });
    expect(await within(c).findByText('Aggiornamento del motore non riuscito')).toBeTruthy();
    await userEvent.click(await within(c).findByRole('button', { name: 'Controlla aggiornamenti' }));
    expect(await within(c).findByText('In C:\\src\\prism ml ci sono modifiche non salvate (2 file): non tocco niente. Salvale o annullale con git, poi ricontrolla.')).toBeTruthy();
    expect(api.calls.some((x) => x.path === '/api/engines/custom/prismml/update?fetch=1')).toBe(true);
  });

  it('every other answer: its own words', async () => {
    bridge();
    const mk = (id: string) => engine({ id, name: id, base: 'llamacpp', run: { mode: 'native', path: `/${id}/llama-server` } });
    const ids = ['diverged', 'noup', 'detached', 'fetch', 'nogit', 'nocmake', 'busy', 'tools', 'pinned', 'repo', 'one', 'broken', 'missing', 'later', 'nodocker', 'noimage', 'slow'];
    const engines = ids.map(mk);
    const w = world({ settings: { ...world().settings, customEngines: engines } });
    w.custom = engines.map((e) => customInfo(e));
    const t = (id: string) => `custom:${id}`;
    Object.assign(w.updates, {
      [t('diverged')]: upd({ target: t('diverged'), method: 'git', state: 'blocked', reason: 'diverged' }),
      [t('noup')]: upd({ target: t('noup'), method: 'git', state: 'blocked', reason: 'no-upstream', branch: 'mine' }),
      [t('detached')]: upd({ target: t('detached'), method: 'git', state: 'blocked', reason: 'detached' }),
      [t('fetch')]: upd({ target: t('fetch'), method: 'git', state: 'blocked', reason: 'fetch-failed', detail: 'Could not resolve host: github.com' }),
      [t('nogit')]: upd({ target: t('nogit'), method: 'git', state: 'blocked', reason: 'git-missing' }),
      [t('nocmake')]: upd({ target: t('nocmake'), method: 'git', state: 'blocked', reason: 'cmake-missing' }),
      [t('busy')]: upd({ target: t('busy'), method: 'git', state: 'blocked' }),
      [t('tools')]: upd({ target: t('tools'), method: 'none', state: 'none' }),
      [t('pinned')]: upd({ target: t('pinned'), method: 'none', state: 'none', reason: 'pinned' }),
      [t('repo')]: upd({ target: t('repo'), method: 'docker-pull', state: 'unknown', image: 'ghcr.io/me/fork:x', commands: [['docker', 'pull', 'ghcr.io/me/fork:x']] }),
      [t('one')]: upd({ target: t('one'), method: 'git', state: 'available', commits: 1, current: 'a', latest: 'b' }),
      [t('missing')]: upd({ target: t('missing'), method: 'docker-pull', state: 'blocked', reason: 'not-installed' }),
      [t('later')]: upd({ target: t('later'), method: 'docker-pull', state: 'current' }),
      [t('nodocker')]: upd({ target: t('nodocker'), method: 'docker-pull', state: 'blocked', reason: 'no-docker' }),
      [t('noimage')]: upd({ target: t('noimage'), method: 'docker-pull', state: 'unknown' }),
      [t('slow')]: upd({ target: t('slow'), method: 'git', state: 'current', current: 'abc1234' }),
    });
    const api = libApi(w);
    api.on('GET /api/engines/custom/broken/update', () => fail('NETWORK'));
    // "Controlla aggiornamenti" on a remote that takes its time.
    let answer!: (c: EngineUpdateCheck) => void;
    api.on('GET /api/engines/custom/slow/update', (_b, q) => (q.get('fetch') === '1' ? new Promise((r) => (answer = r)) : w.updates[t('slow')]));
    renderLib('/engines', api);
    const text = async (id: string, s: string | RegExp) => expect(await within(await card(id)).findByText(s)).toBeTruthy();
    await text('diverged', 'Il ramo ha commit tuoi che quello remoto non ha: aggiornalo con git.');
    await text('noup', 'Il ramo mine non segue un ramo remoto: aggiornalo con git.');
    await text('detached', 'Il checkout non è su un ramo: aggiornalo con git.');
    await text('fetch', 'Non riesco a leggere le novità dal ramo remoto.');
    await text('fetch', 'Could not resolve host: github.com');
    await text('nogit', 'Git non è installato: non posso controllare gli aggiornamenti.');
    await text('nocmake', 'Ci sono commit nuovi, ma per ricompilare serve CMake e non lo trovo.');
    await text('busy', 'Aggiorna questo motore con i suoi strumenti.');
    await text('tools', 'Aggiorna questo motore con i suoi strumenti.');
    await text('pinned', 'L’immagine è fissata a una versione precisa (digest): non cambia.');
    await text('one', '1 commit nuovo: a → b');
    await text('broken', 'Non riesco a controllare se ci sono aggiornamenti.');
    await text('later', 'Hai l’ultima versione');
    await text('nodocker', 'Accendi Docker per controllare gli aggiornamenti.');
    await text('noimage', 'Non so se c’è una versione più nuova di : posso scaricarla di nuovo.');
    const slow = await card('slow');
    await text('slow', 'Hai l’ultima versione (abc1234)');
    await userEvent.click(within(slow).getByRole('button', { name: 'Controlla aggiornamenti' }));
    expect(await within(slow).findByRole('button', { name: 'Controllo…' })).toBeTruthy();
    act(() => answer(upd({ target: t('slow'), method: 'git', state: 'available', commits: 2, current: 'abc1234', latest: 'def5678' })));
    await text('slow', '2 commit nuovi: abc1234 → def5678');
    expect(within(await card('missing')).queryByText(/aggiorn/i)).toBeNull();
    const repo = await card('repo');
    await text('repo', 'Non so se c’è una versione più nuova di ghcr.io/me/fork:x: posso scaricarla di nuovo.');
    await userEvent.click(within(repo).getByRole('button', { name: 'Scarica di nuovo' }));
    const dialog = await screen.findByRole('dialog', { name: 'Aggiornare repo?' });
    expect(within(dialog).getByText('Scarico di nuovo ghcr.io/me/fork:x con le ultime modifiche.')).toBeTruthy();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Scarica di nuovo' }));
    await waitFor(() => expect(api.calls.some((x) => x.method === 'POST' && x.path === '/api/engines/custom/repo/update')).toBe(true));
    // An update the core refuses (a test is running) is said where it was asked.
    api.on('POST /api/engines/custom/one/update', () => fail('ENGINE_UPDATE_FAILED'));
    await userEvent.click(within(await card('one')).getByRole('button', { name: 'Aggiorna' }));
    await userEvent.click(within(await screen.findByRole('dialog', { name: 'Aggiornare one?' })).getByRole('button', { name: 'Aggiorna' }));
    expect(await within(await card('one')).findByText('Aggiornamento del motore non riuscito')).toBeTruthy();
    // A finished update without a version; one that failed without saying why.
    act(() => api.emit({ type: 'engine.install', kind: 'update:custom:later', stage: 'done', bytesDone: 0 }));
    await text('later', 'Aggiornato');
    act(() => api.emit({ type: 'engine.install', kind: 'update:custom:tools', stage: 'error', bytesDone: 0 }));
    await text('tools', 'Aggiornamento del motore non riuscito');
  });

  it('a Docker image of a custom engine: the newer tag replaces it', async () => {
    bridge();
    const team = engine({ id: 'team', name: 'SGLang team', base: 'sglang', run: { mode: 'docker', image: 'me/sglang:v1.2.0' } });
    const w = world({ settings: { ...world().settings, customEngines: [team] } });
    w.custom = [customInfo(team, customCheck({ kind: 'sglang-docker', status: { kind: 'sglang-docker', available: true, installed: true, problems: [], supported: true } }))];
    w.updates['custom:team'] = upd({ target: 'custom:team', method: 'docker-tag', state: 'available', current: 'v1.2.0', latest: 'v1.3.0', image: 'me/sglang:v1.3.0' });
    renderLib('/engines', libApi(w));
    const c = await card('SGLang team');
    await userEvent.click(await within(c).findByRole('button', { name: 'Aggiorna' }));
    expect(await screen.findByText('Scarico me/sglang:v1.3.0 e da ora SGLang team usa questa immagine. Quella di prima (v1.2.0) resta sul PC.')).toBeTruthy();
  });
});

describe('update helpers', () => {
  it('commands as typed in a terminal, headlines, labels and build progress', () => {
    expect(commandLine(['git', '-C', 'C:\\a b', 'pull'])).toBe('git -C "C:\\a b" pull');
    expect(commandLine(['echo', 'say "hi"'])).toBe('echo "say \\"hi\\""');
    expect(updateHeadline(f, upd({ target: 'x', method: 'git', state: 'available' }))).toBe('0 commit nuovi:  → ');
    expect(installLabel(f.t, { type: 'engine.install', kind: 'update:custom:prismml', label: 'PrismML', stage: 'build', bytesDone: 0 })).toBe('Aggiornamento di PrismML');
    expect(installLabel(f.t, { type: 'engine.install', kind: 'update:vllm-native', stage: 'build', bytesDone: 0 })).toBe('Aggiornamento di vllm-native');
    renderUi(<InstallProgress event={{ type: 'engine.install', kind: 'update:x', stage: 'build', bytesDone: 0, step: 45, steps: 100 }} label="b" />);
    expect(screen.getByText('Compilazione')).toBeTruthy();
    expect(screen.getByText('45%')).toBeTruthy();
    // A long compile (NInfer-all's 811 steps): how many, and the time left once its pace is known.
    renderUi(<InstallProgress event={{ type: 'engine.install', kind: 'ninfer-all', stage: 'build', bytesDone: 412, step: 412, steps: 811, etaSec: 750 }} label="n" />);
    expect(screen.getByText('412 di 811 file · 51% · circa 13 min rimasti')).toBeTruthy();
    renderUi(<InstallProgress event={{ type: 'engine.install', kind: 'ninfer-all', stage: 'build', bytesDone: 805, step: 805, steps: 811, etaSec: 20 }} label="m" />);
    expect(screen.getByText('805 di 811 file · 99% · quasi finito')).toBeTruthy();
    renderUi(<InstallProgress event={{ type: 'engine.install', kind: 'update:x', stage: 'git-pull', bytesDone: 0 }} label="g" />);
    expect(screen.getByText('Scarico le modifiche')).toBeTruthy();
  });
});
