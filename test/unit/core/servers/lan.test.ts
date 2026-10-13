import net from 'node:net';
import type { NetworkInterfaceInfo } from 'node:os';
import { describe, expect, it } from 'vitest';
import { DEFAULT_SERVER_PORT } from '../../../../src/contract/servers';
import { redactArgv } from '../../../../src/core/engines/command-display';
import type { LaunchPlan } from '../../../../src/core/engines/types';
import { newServerApiKey, ServerKeys } from '../../../../src/core/servers/api-key';
import { exposeOnLan, LAN_HOST, lanAddresses, lanUrls, redactSecrets } from '../../../../src/core/servers/lan';
import { ServerNotices } from '../../../../src/core/servers/notices';
import { SUGGEST_SPAN, systemPorts } from '../../../../src/core/servers/ports';

const v4 = (address: string, internal = false): NetworkInterfaceInfo => ({ address, family: 'IPv4', internal, netmask: '255.255.255.0', mac: '00:00:00:00:00:00', cidr: null });
const v6 = (address: string): NetworkInterfaceInfo => ({ address, family: 'IPv6', internal: false, netmask: 'ffff::', mac: '00:00:00:00:00:00', cidr: null, scopeid: 0 });

function plan(o: Partial<LaunchPlan> = {}): LaunchPlan {
  return {
    kind: 'llamacpp-native',
    argv: ['llama-server', '-m', 'm.gguf', '--host', '127.0.0.1', '--port', '8080', '--alias', 'x', '--api-key', 'mine', '--api-key=also'],
    env: {},
    host: '127.0.0.1',
    port: 8080,
    params: { extraArgs: [], env: {} },
    engine: { kind: 'llamacpp-native', name: 'llama.cpp' },
    modelFiles: [],
    modelBytes: 0,
    marker: 'gpubench-1',
    ...o,
  };
}

describe('local network addresses', () => {
  it('real cards first, private ranges first; no loopback, link-local or IPv6', () => {
    expect(
      lanAddresses({
        lo: [v4('127.0.0.1', true)],
        'Ethernet': [v4('203.0.113.7'), v4('192.168.1.20'), v6('fe80::1')],
        'Wi-Fi': [v4('169.254.10.2'), v4('10.0.0.5'), v4('172.20.1.1')],
        'vEthernet (WSL)': [v4('172.28.160.1')],
        docker0: [v4('172.17.0.1')],
        empty: undefined,
      }),
    ).toEqual(['192.168.1.20', '10.0.0.5', '172.20.1.1', '203.0.113.7']);
    // Only virtual cards: better than nothing. Node 18.0–18.3 said the family as a number.
    expect(lanAddresses({ vboxnet0: [{ ...v4('192.168.56.1'), family: 4 as unknown as 'IPv4' }], 'VMware Network Adapter': [v4('172.16.5.1'), v4('172.16.5.1')] })).toEqual(['192.168.56.1', '172.16.5.1']);
    expect(lanAddresses({})).toEqual([]);
    expect(lanUrls(['192.168.1.20', '10.0.0.5'], 8081)).toEqual(['http://192.168.1.20:8081/v1', 'http://10.0.0.5:8081/v1']);
  });
});

describe('a launch shared on the local network', () => {
  it('native engines: every card, GPU Bench\'s key only (the user\'s own --api-key is dropped)', () => {
    const p = exposeOnLan(plan(), 'gpub-key');
    expect(p.argv).toEqual(['llama-server', '-m', 'm.gguf', '--host', LAN_HOST, '--port', '8080', '--alias', 'x', '--api-key', 'gpub-key']);
    // GPU Bench still talks to it on 127.0.0.1, with the key.
    expect(p.host).toBe('127.0.0.1');
    expect(p.apiKey).toBe('gpub-key');
    // Shown and stored commands never carry it.
    expect(redactArgv(p.argv)).toContain('<API_KEY>');
    expect(redactArgv(p.argv)).not.toContain('gpub-key');
  });

  it('containers publish the port on every card; vLLM and SGLang take the same flag', () => {
    const docker = plan({ kind: 'vllm-docker', argv: ['docker', 'run', '-p', '127.0.0.1:8080:8000', 'vllm/vllm-openai', '--host', '0.0.0.0', '--port', '8000'] });
    expect(exposeOnLan(docker, 'k').argv).toEqual(['docker', 'run', '-p', '0.0.0.0:8080:8000', 'vllm/vllm-openai', '--host', '0.0.0.0', '--port', '8000', '--api-key', 'k']);
    const sglang = plan({ kind: 'sglang-native', argv: ['python', '-m', 'sglang.launch_server', '--host', '127.0.0.1', '--port', '8080'] });
    expect(exposeOnLan(sglang, 'k').argv.slice(-4)).toEqual(['--port', '8080', '--api-key', 'k']);
  });

  it('command templates and launches without a loopback binding cannot be shared', () => {
    expect(() => exposeOnLan(plan({ kind: 'command', argv: ['srv', '--host', '127.0.0.1'] }), 'k')).toThrow(expect.objectContaining({ code: 'VALIDATION', params: { reason: 'lan_unsupported' } }));
    expect(() => exposeOnLan(plan({ argv: ['llama-server', '--port', '8080'] }), 'k')).toThrow(expect.objectContaining({ params: { reason: 'lan_unsupported' } }));
    expect(() => exposeOnLan(plan({ argv: ['llama-server', '--host', '10.0.0.1'] }), 'k')).toThrow(expect.objectContaining({ params: { reason: 'lan_unsupported' } }));
  });

  it('hides secrets in engine output (short strings are never treated as secrets)', () => {
    expect(redactSecrets("args: {'api_key': ['gpub-abcdef12']} gpub-abcdef12", ['gpub-abcdef12', 'short'])).toBe("args: {'api_key': ['<API_KEY>']} <API_KEY>");
    expect(redactSecrets('plain short', ['short'])).toBe('plain short');
  });
});

describe('the API key', () => {
  const fixed = (b: number) => (n: number) => Buffer.alloc(n, b);

  it('is made the first time, handed to the main process to save, and kept', () => {
    const saved: string[] = [];
    const keys = new ServerKeys({ random: fixed(1) });
    keys.persistWith((k) => saved.push(k));
    const first = keys.current();
    expect(first).toEqual({ key: `gpub-${Buffer.alloc(24, 1).toString('base64url')}`, storage: 'memory' });
    expect(first.key).toHaveLength(37);
    expect(keys.current()).toEqual(first);
    expect(saved).toEqual([first.key]);
    // The main process confirms it saved it encrypted.
    keys.restore(first.key, 'encrypted');
    expect(keys.current()).toEqual({ key: first.key, storage: 'encrypted' });
  });

  it('the saved key from the last session wins, unless one was already made', () => {
    const keys = new ServerKeys({ random: fixed(2) });
    keys.restore('gpub-saved-key-from-before', 'plain');
    expect(keys.current()).toEqual({ key: 'gpub-saved-key-from-before', storage: 'plain' });
    const early = new ServerKeys({ random: fixed(3) });
    const made = early.current().key;
    early.restore('gpub-older', 'encrypted');
    expect(early.current()).toEqual({ key: made, storage: 'memory' });
  });

  it('a new key replaces it; running servers keep theirs, and every key stays hidden in logs', () => {
    let b = 4;
    const keys = new ServerKeys({ random: (n) => Buffer.alloc(n, b++) });
    const a = keys.current().key;
    const c = keys.regenerate();
    expect(c.key).not.toBe(a);
    expect(c.storage).toBe('memory');
    expect(keys.secrets()).toEqual([a, c.key]);
    expect(newServerApiKey()).toMatch(/^gpub-[A-Za-z0-9_-]{32}$/);
  });
});

describe('notices', () => {
  it('newest first, one per preset, at most 20; dismissed one by one', () => {
    let changes = 0;
    let n = 0;
    const notices = new ServerNotices({ now: () => 0, newId: () => `n${++n}`, onChange: () => changes++ });
    notices.add('autostart-failed', { id: 'p1', name: 'A' }, new Error('x'));
    const second = notices.add('tray-start-failed', { id: 'p1', name: 'A' }, 'boom');
    expect(notices.list()).toEqual([second]);
    expect(second.error).toEqual({ code: 'INTERNAL', message: 'boom' });
    const free = notices.add('tray-start-failed', { name: 'Qwen3 8B' }, new Error('y'));
    expect(free).not.toHaveProperty('presetId');
    for (let i = 0; i < 25; i++) notices.add('autostart-failed', { id: `q${i}`, name: 'Q' }, new Error('z'));
    expect(notices.list()).toHaveLength(20);
    notices.dismiss('nope');
    const before = changes;
    notices.dismiss(notices.list()[0]!.id);
    expect(changes).toBe(before + 1);
    notices.clearPreset('nope');
    notices.clearPreset('q24');
    expect(notices.list().some((x) => x.presetId === 'q24')).toBe(false);
    expect(new ServerNotices({ now: () => 0 }).add('autostart-failed', { name: 'x' }, new Error('e')).id).toMatch(/-/);
  });
});

describe('server ports', () => {
  it('the first port from 8080 free on both 127.0.0.1 and every card, skipping ours; else any free one', async () => {
    const busy = new Map([
      ['127.0.0.1:8080', true],
      ['0.0.0.0:8081', true],
    ]);
    const ports = systemPorts(async (port, host) => !busy.has(`${host}:${port}`), async () => 5);
    expect(await ports.suggest([8082])).toBe(8083);
    expect(await ports.free(8080)).toBe(false);
    expect(await ports.free(8081)).toBe(false);
    expect(await ports.free(8084)).toBe(true);
    const full = systemPorts(async () => false, async () => 41_000);
    expect(await full.suggest([])).toBe(41_000);
    expect(DEFAULT_SERVER_PORT + SUGGEST_SPAN).toBe(8180);
  });

  it('really checks the OS', async () => {
    const srv = net.createServer();
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
    const taken = (srv.address() as net.AddressInfo).port;
    const ports = systemPorts();
    expect(await ports.free(taken)).toBe(false);
    await new Promise((r) => srv.close(r));
    const any = await systemPorts(async () => false).suggest([]);
    expect(any).toBeGreaterThan(0);
  });
});
