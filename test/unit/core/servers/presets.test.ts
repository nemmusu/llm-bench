import { describe, expect, it } from 'vitest';
import { SERVER_PRESETS_MAX, type ServerPreset } from '../../../../src/contract/servers';
import { defaultSettings, settingsSchema } from '../../../../src/contract/settings';
import { presetRequest, ServerPresets } from '../../../../src/core/servers/presets';

function store(initial: ServerPreset[] = []) {
  const s = { presets: initial, writes: 0 };
  return {
    s,
    get: async () => ({ serverPresets: s.presets }),
    update: async (p: { serverPresets: ServerPreset[] }) => {
      s.presets = p.serverPresets;
      s.writes++;
    },
  };
}

function presets(initial: ServerPreset[] = []) {
  let n = 0;
  let now = Date.UTC(2026, 9, 13, 10);
  const st = store(initial);
  const p = new ServerPresets({ store: st, now: () => now, newId: () => `id-${++n}` });
  return { p, st, later: () => (now += 60_000) };
}

const input = {
  name: '  Chat veloce ',
  engine: { kind: 'llamacpp-native' },
  model: { localId: 'qwen' },
  modelLabel: 'Qwen3 8B · Q4_K_M',
  params: { contextSize: 32768, kvCacheType: 'q8_0', extraArgs: ['--mlock'] },
  port: 8080,
  source: { kind: 'config', runId: 'r1' },
};

describe('server presets', () => {
  it('saves a preset with its port, settings and extra arguments; network and auto-start off unless asked', async () => {
    const { p, st } = presets();
    const saved = await p.create(input);
    expect(saved).toEqual({
      id: 'id-1',
      name: 'Chat veloce',
      engine: { kind: 'llamacpp-native' },
      model: { localId: 'qwen' },
      modelLabel: 'Qwen3 8B · Q4_K_M',
      params: { contextSize: 32768, kvCacheType: 'q8_0', extraArgs: ['--mlock'], env: {} },
      port: 8080,
      network: 'local',
      autoStart: false,
      source: { kind: 'config', runId: 'r1' },
      createdAt: '2026-10-13T10:00:00.000Z',
      updatedAt: '2026-10-13T10:00:00.000Z',
    });
    expect(await p.list()).toEqual([saved]);
    expect(await p.get('id-1')).toEqual(saved);
    expect(st.s.writes).toBe(1);
    expect(await p.autoStart()).toEqual([]);
  });

  it('changes some fields, keeps the rest, removes the port or the source with null', async () => {
    const { p, later } = presets();
    const saved = await p.create(input);
    later();
    const changed = await p.update(saved.id, { autoStart: true, network: 'lan', port: null, source: null });
    expect(changed).toMatchObject({ id: saved.id, name: 'Chat veloce', autoStart: true, network: 'lan', createdAt: saved.createdAt, updatedAt: '2026-10-13T10:01:00.000Z' });
    expect(changed).not.toHaveProperty('port');
    expect(changed).not.toHaveProperty('source');
    expect(await p.autoStart()).toEqual([changed]);
    // Its own name is not a clash.
    expect((await p.update(saved.id, { name: 'chat VELOCE' })).name).toBe('chat VELOCE');
  });

  it('refuses what cannot work: no name, a name in use, a bad port, an external endpoint, no model, too many', async () => {
    const { p } = presets();
    const saved = await p.create(input);
    await expect(p.create({ ...input, name: 'CHAT veloce' })).rejects.toMatchObject({ code: 'VALIDATION', params: { reason: 'preset_name_taken', name: 'CHAT veloce' } });
    await expect(p.create({ ...input, name: '   ' })).rejects.toMatchObject({ params: { reason: 'preset_invalid', field: 'name' } });
    await expect(p.create({ ...input, name: 'x', port: 80 })).rejects.toMatchObject({ params: { reason: 'preset_invalid', field: 'port' } });
    await expect(p.create({ ...input, name: 'x', engine: { kind: 'external', baseUrl: 'http://h:1' } })).rejects.toMatchObject({ params: { reason: 'external' } });
    await expect(p.create({ ...input, name: 'x', model: {} })).rejects.toMatchObject({ params: { reason: 'model_required' } });
    await expect(p.create({ ...input, name: 'x', engine: { kind: 'command', command: 'srv --port {port}' }, network: 'lan' })).rejects.toMatchObject({ params: { reason: 'lan_unsupported' } });
    expect((await p.create({ ...input, name: 'cmd', engine: { kind: 'command', command: 'srv --port {port}' } })).engine.kind).toBe('command');
    await expect(p.create(null)).rejects.toMatchObject({ params: { reason: 'preset_invalid', field: '' } });
    await expect(p.update(saved.id, { name: 'cmd' })).rejects.toMatchObject({ params: { reason: 'preset_name_taken' } });
    await expect(p.update('nope', {})).rejects.toMatchObject({ params: { reason: 'preset_not_found', id: 'nope' } });
    await expect(p.get('nope')).rejects.toMatchObject({ params: { reason: 'preset_not_found' } });
    await expect(p.remove('nope')).rejects.toMatchObject({ params: { reason: 'preset_not_found' } });
    const full = presets(Array.from({ length: SERVER_PRESETS_MAX }, (_, i) => ({ ...saved, id: `p${i}`, name: `P${i}` })));
    await expect(full.p.create({ ...input, name: 'one more' })).rejects.toMatchObject({ params: { reason: 'too_many_presets', max: SERVER_PRESETS_MAX } });
  });

  it('removes a preset', async () => {
    const { p } = presets();
    const a = await p.create(input);
    const b = await p.create({ ...input, name: 'Altro' });
    await p.remove(a.id);
    expect(await p.list()).toEqual([b]);
  });

  it('the request of a preset carries its port, network and id', async () => {
    const { p } = presets();
    const a = await p.create({ ...input, network: 'lan' });
    expect(presetRequest(a)).toEqual({ engine: a.engine, model: a.model, params: a.params, port: 8080, network: 'lan', presetId: a.id });
    const { port: _port, ...noPort } = a;
    expect(presetRequest(noPort)).not.toHaveProperty('port');
    // "Senza la ricetta del modello" is remembered.
    const plain = await p.create({ ...input, name: 'Senza ricetta', recipe: { use: false } });
    expect(presetRequest(plain).recipe).toEqual({ use: false });
  });

  it('settings.json: an invalid preset is dropped on read, never the whole file', () => {
    const good = { ...input, name: 'Buono', id: 'a', network: 'local', autoStart: true, createdAt: 'x', updatedAt: 'x' };
    const s = settingsSchema.parse({ theme: 'dark', serverPresets: [good, { id: 'broken' }, 42], closeBehavior: 'tray' });
    expect(s.theme).toBe('dark');
    expect(s.serverPresets.map((x) => x.id)).toEqual(['a']);
    expect(s.closeBehavior).toBe('tray');
    expect(defaultSettings()).toMatchObject({ serverPresets: [], closeBehavior: 'tray-if-servers', launchAtLogin: false });
  });
});
