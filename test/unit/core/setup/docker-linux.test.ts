import { describe, expect, it } from 'vitest';
import {
  DOCKER_INSTALL_DOCS,
  LINUX_SCRIPT,
  LINUX_STEPS,
  SCRIPT_NAME,
  USER_NAME_RE,
  linuxDistroSupport,
  linuxInstallArgv,
  parseMarker,
  runLinuxInstall,
  type LinuxInstallProgress,
} from '../../../../src/core/setup/docker-linux';
import { parseOsRelease } from '../../../../src/core/setup/os-release';
import { FakeRunner, type FakeProcess } from '../telemetry/fakes';

describe('LINUX_SCRIPT', () => {
  it('announces every step in order with the right total', () => {
    const steps = [...LINUX_SCRIPT.matchAll(/^step (\d+) ([a-z-]+)$/gm)].map((m) => [Number(m[1]), m[2]]);
    expect(steps).toEqual(LINUX_STEPS.map((s, i) => [i + 1, s]));
    expect(LINUX_SCRIPT).toContain(`TOTAL=${LINUX_STEPS.length}\n`);
    expect(LINUX_SCRIPT).toContain('##GPUBENCH_DONE');
  });

  it('uses the official repositories and commands', () => {
    expect(LINUX_SCRIPT).toContain('https://download.docker.com/linux/${DOCKER_OS}/gpg');
    expect(LINUX_SCRIPT).toContain('Signed-By: /etc/apt/keyrings/docker.asc');
    expect(LINUX_SCRIPT).toContain('docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin');
    expect(LINUX_SCRIPT).toContain('https://nvidia.github.io/libnvidia-container/gpgkey');
    expect(LINUX_SCRIPT).toContain('https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list');
    expect(LINUX_SCRIPT).toContain('nvidia-ctk runtime configure --runtime=docker');
    expect(LINUX_SCRIPT).toContain('usermod -aG docker -- "$TARGET_USER"');
  });

  it('validates the user with the same rule as the app, before using it', () => {
    expect(LINUX_SCRIPT).toContain(`USER_RE='${USER_NAME_RE.source}'`);
    const firstUse = LINUX_SCRIPT.indexOf('id -u -- "$TARGET_USER"');
    expect(LINUX_SCRIPT.indexOf('[[ "$TARGET_USER" =~ $USER_RE ]] || fail invalid-user')).toBeLessThan(firstUse);
    for (const ok of ['nemmusu', 'root', '_svc', 'a.b-c_d']) expect(USER_NAME_RE.test(ok)).toBe(true);
    for (const bad of ['', '-rf', 'Bad', 'a b', 'x;rm', '$(id)', 'a'.repeat(33)]) expect(USER_NAME_RE.test(bad)).toBe(false);
  });

  it('keeps an existing Docker Engine', () => {
    expect(LINUX_SCRIPT).toMatch(/if command -v dockerd >\/dev\/null 2>&1; then\n {2}echo "Docker Engine already installed/);
  });
});

describe('linuxDistroSupport', () => {
  it('supports Ubuntu, Debian and Ubuntu derivatives', () => {
    expect(linuxDistroSupport(parseOsRelease('ID=ubuntu\nVERSION_CODENAME=noble\nUBUNTU_CODENAME=noble'))).toEqual({
      supported: true,
      distro: 'ubuntu',
      dockerOs: 'ubuntu',
      codename: 'noble',
    });
    expect(linuxDistroSupport(parseOsRelease('ID=ubuntu\nVERSION_CODENAME=jammy'))).toMatchObject({ supported: true, codename: 'jammy' });
    expect(linuxDistroSupport(parseOsRelease('ID=debian\nVERSION_CODENAME=trixie'))).toMatchObject({ supported: true, dockerOs: 'debian', codename: 'trixie' });
    expect(linuxDistroSupport(parseOsRelease('ID=linuxmint\nID_LIKE="ubuntu debian"\nVERSION_CODENAME=wilma\nUBUNTU_CODENAME=noble'))).toMatchObject({
      supported: true,
      distro: 'linuxmint',
      dockerOs: 'ubuntu',
      codename: 'noble',
    });
  });

  it('refuses the rest with the docs link', () => {
    expect(linuxDistroSupport(undefined)).toEqual({ supported: false, reason: 'no-os-release', docs: DOCKER_INSTALL_DOCS });
    expect(linuxDistroSupport(parseOsRelease('ID=fedora'))).toEqual({ supported: false, distro: 'fedora', reason: 'unsupported-distro', docs: DOCKER_INSTALL_DOCS });
    expect(linuxDistroSupport(parseOsRelease('ID=debian'))).toMatchObject({ supported: false });
    expect(linuxDistroSupport(parseOsRelease('ID=ubuntu'))).toMatchObject({ supported: false });
    expect(linuxDistroSupport(parseOsRelease('ID=pop\nID_LIKE=ubuntu'))).toMatchObject({ supported: false });
  });
});

describe('parseMarker', () => {
  it('recognizes the markers only', () => {
    expect(parseMarker('##GPUBENCH_STEP 3/7 docker-repo')).toEqual({ kind: 'step', marker: { step: 3, total: 7, name: 'docker-repo' } });
    expect(parseMarker('##GPUBENCH_ERROR unsupported-distro')).toEqual({ kind: 'error', code: 'unsupported-distro' });
    expect(parseMarker('##GPUBENCH_DONE')).toEqual({ kind: 'done' });
    expect(parseMarker('Get:1 http://archive.ubuntu.com noble InRelease')).toBeUndefined();
    expect(parseMarker(' ##GPUBENCH_DONE')).toBeUndefined();
  });

  it('builds the pkexec argv with the script verbatim and the user as $1', () => {
    expect(linuxInstallArgv('nemmusu')).toEqual(['pkexec', '/bin/bash', '-c', LINUX_SCRIPT, SCRIPT_NAME, 'nemmusu']);
  });
});

describe('runLinuxInstall', () => {
  function scripted(lines: string[], code: number | null, signal: string | null = null) {
    return new FakeRunner(undefined, undefined, (p: FakeProcess) => {
      queueMicrotask(() => {
        for (const l of lines) p.emit(l);
        p.exit(code, signal);
      });
    });
  }

  it('streams the steps and finishes with relogin-required', async () => {
    const proc = scripted(['##GPUBENCH_STEP 1/7 prepare', 'Reading package lists...', '##GPUBENCH_STEP 7/7 docker-group', '##GPUBENCH_DONE'], 0);
    const seen: LinuxInstallProgress[] = [];
    const r = await runLinuxInstall(proc, 'nemmusu', (p) => seen.push(p));
    expect(r.outcome).toBe('relogin-required');
    expect(r.lines).toContain('Reading package lists...');
    expect(seen).toEqual([
      { stage: 'prepare', step: 1, total: 7 },
      { stage: 'docker-group', step: 7, total: 7 },
    ]);
    const spec = proc.spawned[0]?.spec;
    expect(spec?.cmd).toBe('pkexec');
    expect(spec?.args).toEqual(['/bin/bash', '-c', LINUX_SCRIPT, SCRIPT_NAME, 'nemmusu']);
  });

  it('keeps only the last lines', async () => {
    const lines = Array.from({ length: 100 }, (_, i) => `line ${i}`);
    const r = await runLinuxInstall(scripted([...lines, '##GPUBENCH_DONE'], 0), 'u', () => {});
    expect(r.lines).toHaveLength(60);
    expect(r.lines.at(-1)).toBe('##GPUBENCH_DONE');
  });

  it('validates the user before spawning anything', async () => {
    const proc = scripted([], 0);
    await expect(runLinuxInstall(proc, 'x;reboot', () => {})).rejects.toMatchObject({ code: 'VALIDATION' });
    expect(proc.spawned).toHaveLength(0);
    const ac = new AbortController();
    ac.abort();
    await expect(runLinuxInstall(proc, 'u', () => {}, ac.signal)).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(proc.spawned).toHaveLength(0);
  });

  it('maps pkexec and script failures', async () => {
    const run = (lines: string[], code: number | null, sig: string | null = null) => runLinuxInstall(scripted(lines, code, sig), 'u', () => {});
    await expect(run([], 126)).rejects.toMatchObject({ code: 'CANCELLED', params: { reason: 'auth-dismissed' } });
    await expect(run(['Error executing command as another user: Not authorized'], 127)).rejects.toMatchObject({
      code: 'ENGINE_INSTALL_FAILED',
      params: { reason: 'not-authorized' },
      detail: 'Error executing command as another user: Not authorized',
    });
    await expect(run(['Error: spawn pkexec ENOENT'], null)).rejects.toMatchObject({ params: { reason: 'pkexec-missing' } });
    await expect(run(['##GPUBENCH_ERROR unsupported-distro'], 65)).rejects.toMatchObject({ params: { reason: 'unsupported-distro', exitCode: '65' } });
    await expect(run(['E: Unable to locate package'], 100)).rejects.toMatchObject({ params: { reason: 'script-failed', exitCode: '100' } });
    await expect(run([], null, 'SIGKILL')).rejects.toMatchObject({ params: { reason: 'script-failed', exitCode: 'SIGKILL' } });
    // Exit 0 without the final marker means the script was cut short.
    await expect(run(['##GPUBENCH_STEP 1/7 prepare'], 0)).rejects.toMatchObject({ params: { reason: 'script-failed' } });
  });
});
