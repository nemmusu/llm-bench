/**
 * "Rendi raggiungibile dalla rete locale": a server bound to every network card of this PC that
 * answers only with LLM Bench's API key. Engines are started on 127.0.0.1 by default (ports.ts
 * LOOPBACK); this turns an exact launch into its network version, whatever the engine.
 */
import type { NetworkInterfaceInfo } from 'node:os';
import { AppError } from '../../contract/errors';
import { engineBaseOf } from '../../contract/engines';
import type { LaunchPlan } from '../engines/types';
import { LOOPBACK } from '../process/ports';

/** Every IPv4 interface. */
export const LAN_HOST = '0.0.0.0';

/** Network cards of virtual machines, containers and VPN-less bridges: other devices cannot reach those addresses. */
const VIRTUAL = /docker|^br-|^veth|virbr|vboxnet|virtualbox|vmnet|vmware|vethernet|hyper-v|wsl|^lo\b|loopback|tailscale|zerotier/i;

/** 192.168/16, 10/8, 172.16/12: the private ranges of home and office networks. */
function isPrivate(ip: string): boolean {
  const [a, b] = ip.split('.').map(Number) as [number, number];
  return a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31);
}

/**
 * The IPv4 addresses other devices on the local network use to reach this PC: no loopback, no
 * link-local (169.254), private ranges first. Cards of virtual machines and containers come last,
 * and only when there is nothing else.
 */
export function lanAddresses(ifaces: Readonly<Record<string, readonly NetworkInterfaceInfo[] | undefined>>): string[] {
  const real: string[] = [];
  const virtual: string[] = [];
  for (const [name, list] of Object.entries(ifaces)) {
    for (const i of list ?? []) {
      // Node 18.0–18.3 reported the family as a number.
      const v4 = i.family === 'IPv4' || (i.family as unknown) === 4;
      if (!v4 || i.internal || i.address.startsWith('169.254.')) continue;
      (VIRTUAL.test(name) ? virtual : real).push(i.address);
    }
  }
  const order = (list: string[]) => [...new Set(list)].sort((x, y) => Number(isPrivate(y)) - Number(isPrivate(x)));
  return real.length ? order(real) : order(virtual);
}

/** "http://192.168.1.20:8080/v1" for each address. */
export function lanUrls(addresses: readonly string[], port: number): string[] {
  return addresses.map((a) => `http://${a}:${port}/v1`);
}

/** Removes `--api-key X` / `--api-key=X` the user may have typed: the key of a network server is always LLM Bench's. */
function withoutApiKey(argv: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === '--api-key') {
      i++;
      continue;
    }
    if (!a.startsWith('--api-key=')) out.push(a);
  }
  return out;
}

/**
 * The same launch, reachable from the local network: `--host 127.0.0.1` becomes 0.0.0.0 (native
 * engines), `-p 127.0.0.1:H:C` becomes 0.0.0.0:H:C (containers, whose engine already listens on every
 * card inside), and `--api-key <key>` is added at the end (llama.cpp, vLLM and SGLang all take it).
 * LLM Bench keeps talking to it on 127.0.0.1 (plan.host), with the key (plan.apiKey). Command
 * templates are the user's own programs: they cannot be shared this way (VALIDATION 'lan_unsupported').
 */
export function exposeOnLan(plan: LaunchPlan, apiKey: string): LaunchPlan {
  const unsupported = () => new AppError('VALIDATION', 'This engine cannot be shared on the local network', { params: { reason: 'lan_unsupported' } });
  if (engineBaseOf(plan.kind) === 'external') throw unsupported();
  const argv = withoutApiKey(plan.argv);
  let bound = false;
  for (let i = 0; i < argv.length - 1; i++) {
    const next = argv[i + 1] as string;
    if (argv[i] === '--host' && next === LOOPBACK) {
      argv[i + 1] = LAN_HOST;
      bound = true;
    } else if (argv[i] === '-p' && next.startsWith(`${LOOPBACK}:`)) {
      argv[i + 1] = `${LAN_HOST}:${next.slice(LOOPBACK.length + 1)}`;
      bound = true;
    }
  }
  if (!bound) throw unsupported();
  return { ...plan, argv: [...argv, '--api-key', apiKey], apiKey };
}

/** Hides every secret in a line of the engine's output (vLLM prints its non-default args, the key included). */
export function redactSecrets(text: string, secrets: readonly string[], placeholder = '<API_KEY>'): string {
  let out = text;
  for (const s of secrets) if (s.length >= 8) out = out.split(s).join(placeholder);
  return out;
}
