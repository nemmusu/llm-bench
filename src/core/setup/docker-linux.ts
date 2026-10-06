import { AppError } from '../../contract/errors';
import type { ProcessRunner } from '../deps';
import { isUbuntuLike, type OsRelease } from './os-release';

/**
 * Login names we pass to the script. Same rule as the script's own check (both must agree):
 * lower-case POSIX-ish names, no leading dash, at most 32 chars (useradd's limit).
 */
export const USER_NAME_RE = /^[a-z_][a-z0-9_.-]{0,31}$/;

/** Steps announced by the script, in order (`##GPUBENCH_STEP <n>/<total> <name>`). */
export const LINUX_STEPS = ['prepare', 'prerequisites', 'docker-repo', 'docker-install', 'nvidia-toolkit', 'configure', 'docker-group'] as const;
export type LinuxStep = (typeof LINUX_STEPS)[number];

/** Program name ($0) the script runs under, so `ps` shows what it is. */
export const SCRIPT_NAME = 'gpubench-installer';

/**
 * The exact script run as root through pkexec. It is a constant: nothing from the app or the
 * user is interpolated. The only input is the login name, passed as positional argument $1
 * and validated by the script itself before any use.
 *
 * Sources (checked 2026-10-06):
 *  - Docker Engine on Ubuntu / Debian, apt repository method:
 *    https://docs.docker.com/engine/install/ubuntu/ and https://docs.docker.com/engine/install/debian/
 *    (deb822 docker.sources, Suites = UBUNTU_CODENAME or VERSION_CODENAME, keyring docker.asc)
 *  - Linux post-install, docker group: https://docs.docker.com/engine/install/linux-postinstall/
 *  - NVIDIA Container Toolkit, apt: https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html
 *    (gpgkey → keyring, nvidia-container-toolkit.list with signed-by via sed,
 *    `nvidia-ctk runtime configure --runtime=docker`, restart docker). The guide's optional
 *    version pin is left out on purpose: a pin baked into the app would go stale.
 *
 * Docker Engine is skipped when dockerd already exists (e.g. distro docker.io): replacing it
 * would mean removing the user's packages, and the NVIDIA runtime works with it too.
 */
export const LINUX_SCRIPT = [
  'set -euo pipefail',
  'export DEBIAN_FRONTEND=noninteractive',
  'TOTAL=7',
  'step() { echo "##GPUBENCH_STEP $1/$TOTAL $2"; }',
  'fail() { echo "##GPUBENCH_ERROR $1"; exit "$2"; }',
  '',
  'step 1 prepare',
  'TARGET_USER="${1:-}"',
  "USER_RE='^[a-z_][a-z0-9_.-]{0,31}$'",
  '[[ "$TARGET_USER" =~ $USER_RE ]] || fail invalid-user 64',
  'id -u -- "$TARGET_USER" >/dev/null 2>&1 || fail unknown-user 64',
  '. /etc/os-release',
  'case "${ID:-}" in',
  '  ubuntu) DOCKER_OS=ubuntu; SUITE="${UBUNTU_CODENAME:-${VERSION_CODENAME:-}}" ;;',
  '  debian) DOCKER_OS=debian; SUITE="${VERSION_CODENAME:-}" ;;',
  '  *)',
  '    if [[ " ${ID_LIKE:-} " == *" ubuntu "* && -n "${UBUNTU_CODENAME:-}" ]]; then',
  '      DOCKER_OS=ubuntu; SUITE="$UBUNTU_CODENAME"',
  '    else',
  '      fail unsupported-distro 65',
  '    fi ;;',
  'esac',
  "SUITE_RE='^[a-z0-9-]+$'",
  '[[ "$SUITE" =~ $SUITE_RE ]] || fail unsupported-distro 65',
  '',
  'step 2 prerequisites',
  'apt-get update',
  'apt-get install -y --no-install-recommends ca-certificates curl gnupg',
  '',
  'step 3 docker-repo',
  'if command -v dockerd >/dev/null 2>&1; then',
  '  echo "Docker Engine already installed: keeping it"',
  'else',
  '  install -m 0755 -d /etc/apt/keyrings',
  '  curl -fsSL "https://download.docker.com/linux/${DOCKER_OS}/gpg" -o /etc/apt/keyrings/docker.asc',
  '  chmod a+r /etc/apt/keyrings/docker.asc',
  '  cat > /etc/apt/sources.list.d/docker.sources <<EOF',
  'Types: deb',
  'URIs: https://download.docker.com/linux/${DOCKER_OS}',
  'Suites: ${SUITE}',
  'Components: stable',
  'Architectures: $(dpkg --print-architecture)',
  'Signed-By: /etc/apt/keyrings/docker.asc',
  'EOF',
  '  apt-get update',
  'fi',
  '',
  'step 4 docker-install',
  'if ! command -v dockerd >/dev/null 2>&1; then',
  '  apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin',
  'fi',
  '',
  'step 5 nvidia-toolkit',
  'curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey | gpg --dearmor --yes -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg',
  "curl -fsSL https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list | sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' > /etc/apt/sources.list.d/nvidia-container-toolkit.list",
  'apt-get update',
  'apt-get install -y nvidia-container-toolkit',
  '',
  'step 6 configure',
  'nvidia-ctk runtime configure --runtime=docker',
  // WSL distros without systemd only have the SysV service wrapper.
  'systemctl restart docker || service docker restart',
  '',
  'step 7 docker-group',
  'groupadd -f docker',
  'usermod -aG docker -- "$TARGET_USER"',
  'echo "##GPUBENCH_DONE"',
  '',
].join('\n');

export type LinuxDistroSupport =
  | { supported: true; distro: string; dockerOs: 'ubuntu' | 'debian'; codename: string }
  | { supported: false; distro?: string; reason: 'unsupported-distro' | 'no-os-release'; docs: string };

export const DOCKER_INSTALL_DOCS = 'https://docs.docker.com/engine/install/';

/** Mirrors the script's distro rule so the UI can tell before asking for a password. */
export function linuxDistroSupport(os: OsRelease | undefined): LinuxDistroSupport {
  if (!os) return { supported: false, reason: 'no-os-release', docs: DOCKER_INSTALL_DOCS };
  if (os.id === 'debian' && os.versionCodename) return { supported: true, distro: os.id, dockerOs: 'debian', codename: os.versionCodename };
  const ubuntuCodename = os.id === 'ubuntu' ? (os.ubuntuCodename ?? os.versionCodename) : os.ubuntuCodename;
  if (isUbuntuLike(os) && ubuntuCodename) return { supported: true, distro: os.id, dockerOs: 'ubuntu', codename: ubuntuCodename };
  return { supported: false, distro: os.id, reason: 'unsupported-distro', docs: DOCKER_INSTALL_DOCS };
}

export interface StepMarker {
  step: number;
  total: number;
  name: string;
}

/** Parses one script output line; undefined for ordinary apt output. */
export function parseMarker(line: string): { kind: 'step'; marker: StepMarker } | { kind: 'error'; code: string } | { kind: 'done' } | undefined {
  const step = /^##GPUBENCH_STEP (\d+)\/(\d+) ([a-z-]+)\s*$/.exec(line);
  if (step) return { kind: 'step', marker: { step: Number(step[1]), total: Number(step[2]), name: step[3] as string } };
  const err = /^##GPUBENCH_ERROR ([a-z-]+)\s*$/.exec(line);
  if (err) return { kind: 'error', code: err[1] as string };
  if (/^##GPUBENCH_DONE\s*$/.test(line)) return { kind: 'done' };
  return undefined;
}

/** The argv shown to the user and executed (pkexec runs the fixed script as root). */
export function linuxInstallArgv(user: string): string[] {
  return ['pkexec', '/bin/bash', '-c', LINUX_SCRIPT, SCRIPT_NAME, user];
}

export interface LinuxInstallProgress {
  stage: string;
  step: number;
  total: number;
}

export interface LinuxInstallResult {
  /** Group membership only applies to new login sessions. */
  outcome: 'relogin-required';
  lines: string[];
}

/** Last output lines kept for "Dettagli". */
const TAIL = 60;

function failed(reason: string, detail: string, params: Record<string, string | number> = {}): AppError {
  return new AppError('ENGINE_INSTALL_FAILED', `Docker install failed: ${reason}`, {
    params: { component: 'docker-linux', reason, ...params },
    detail,
  });
}

/**
 * Runs the install through pkexec, streaming the script's markers as progress. Cancelling is
 * only possible before the password prompt is answered: the root shell cannot (and must not)
 * be killed by us halfway through apt.
 *
 * pkexec exit codes: 126 = the user dismissed the authentication dialog, 127 = not authorized
 * or no polkit agent (see pkexec(1)).
 */
export async function runLinuxInstall(
  proc: ProcessRunner,
  user: string,
  progress: (p: LinuxInstallProgress) => void,
  signal?: AbortSignal,
): Promise<LinuxInstallResult> {
  if (!USER_NAME_RE.test(user)) {
    throw new AppError('VALIDATION', 'Unsupported login name for the docker group', { params: { reason: 'invalid-user' } });
  }
  if (signal?.aborted) throw new AppError('CANCELLED', 'Docker install cancelled');
  const [cmd, ...args] = linuxInstallArgv(user) as [string, ...string[]];
  const mp = proc.spawn({ cmd, args, owner: { runId: 'setup-docker-linux', marker: SCRIPT_NAME } });
  const tail: string[] = [];
  let errorCode: string | undefined;
  let done = false;
  for await (const l of mp.lines) {
    const m = parseMarker(l.text);
    if (m?.kind === 'step') progress({ stage: m.marker.name, step: m.marker.step, total: m.marker.total });
    else if (m?.kind === 'error') errorCode = m.code;
    else if (m?.kind === 'done') done = true;
    tail.push(l.text);
    if (tail.length > TAIL) tail.shift();
  }
  const exit = await mp.exited;
  const detail = tail.join('\n');
  if (exit.code === 0 && done) return { outcome: 'relogin-required', lines: tail };
  if (exit.code === 126) throw new AppError('CANCELLED', 'Authentication dismissed', { params: { reason: 'auth-dismissed' } });
  if (exit.code === 127) throw failed('not-authorized', detail);
  if (exit.code === null && tail.some((t) => /\bENOENT\b/.test(t))) throw failed('pkexec-missing', detail);
  if (errorCode !== undefined) throw failed(errorCode, detail, { exitCode: String(exit.code) });
  throw failed('script-failed', detail, { exitCode: String(exit.code ?? exit.signal) });
}
