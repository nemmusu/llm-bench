import { AppError } from '../../contract/errors';

/** A parsed image reference: `[registry/]repository[:tag][@digest]`. */
export interface ImageRef {
  /** Registry host (with port), absent for Docker Hub short names. */
  registry?: string;
  /** Path inside the registry, e.g. "vllm/vllm-openai" or "library/ubuntu" (Hub official images). */
  repository: string;
  tag?: string;
  digest?: string;
}

const HUB_HOSTS = new Set(['docker.io', 'index.docker.io', 'registry-1.docker.io']);
/** Lower-case path components separated by "/", like the reference grammar of distribution/reference. */
const PATH = /^[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*(?:\/[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*)*$/;
const TAG = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;
const DIGEST = /^[a-z0-9]+(?:[+._-][a-z0-9]+)*:[a-fA-F0-9]{32,}$/;
const HOST = /^(?:localhost|[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+|[A-Za-z0-9-]+)(?::\d+)?$/;

/**
 * Parses and validates an image reference. Validation matters beyond correctness: the
 * reference becomes a docker CLI argument, and a value starting with "-" would be read as a flag.
 */
export function parseImageRef(ref: string): ImageRef {
  const bad = () => new AppError('VALIDATION', `Invalid image reference: ${ref}`, { params: { image: ref } });
  let rest = ref.trim();
  if (rest !== ref || rest === '') throw bad();
  let digest: string | undefined;
  const at = rest.indexOf('@');
  if (at >= 0) {
    digest = rest.slice(at + 1);
    rest = rest.slice(0, at);
    if (!DIGEST.test(digest)) throw bad();
  }
  let tag: string | undefined;
  const colon = rest.lastIndexOf(':');
  if (colon > rest.lastIndexOf('/')) {
    tag = rest.slice(colon + 1);
    rest = rest.slice(0, colon);
    if (!TAG.test(tag)) throw bad();
  }
  let registry: string | undefined;
  const slash = rest.indexOf('/');
  const first = slash >= 0 ? rest.slice(0, slash) : '';
  // Same rule as the docker CLI: the first component is a host when it has a dot, a port or is "localhost".
  if (slash >= 0 && (first.includes('.') || first.includes(':') || first === 'localhost')) {
    if (!HOST.test(first)) throw bad();
    registry = first;
    rest = rest.slice(slash + 1);
  }
  if (!PATH.test(rest)) throw bad();
  if (registry !== undefined && HUB_HOSTS.has(registry)) registry = undefined;
  if (registry === undefined && !rest.includes('/')) rest = `library/${rest}`;
  const out: ImageRef = { repository: rest };
  if (registry !== undefined) out.registry = registry;
  if (tag !== undefined) out.tag = tag;
  if (digest !== undefined) out.digest = digest;
  return out;
}

export function isDockerHub(r: ImageRef): boolean {
  return r.registry === undefined;
}

/** Repository as Docker prints it in RepoTags/RepoDigests ("ubuntu", "vllm/vllm-openai", "ghcr.io/x/y"). */
export function displayRepo(r: ImageRef): string {
  if (r.registry !== undefined) return `${r.registry}/${r.repository}`;
  return r.repository.startsWith('library/') ? r.repository.slice('library/'.length) : r.repository;
}

/** Tag or digest to request (`latest` when the reference has neither). */
export function refVersion(r: ImageRef): string {
  return r.digest ?? r.tag ?? 'latest';
}

/**
 * Picks the digest matching the reference's repository among RepoDigests
 * (an image pulled under two names has two entries). Returns just "sha256:…".
 */
export function digestFor(ref: string, repoDigests: readonly string[]): string | undefined {
  let want: string | undefined;
  try {
    want = displayRepo(parseImageRef(ref));
  } catch {
    want = undefined;
  }
  const split = repoDigests.map((d) => {
    const i = d.lastIndexOf('@');
    return { repo: d.slice(0, i), digest: d.slice(i + 1) };
  });
  const match = split.find((d) => d.repo === want) ?? split[0];
  return match?.digest || undefined;
}
