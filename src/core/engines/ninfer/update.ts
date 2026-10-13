/**
 * "Controlla aggiornamenti" and "Aggiorna" for a NInfer build made from a git checkout, on Linux or
 * inside the chosen WSL distro, and only inside that checkout:
 *
 *   check   git fetch (only the checkout's remote-tracking branches change), then where HEAD stands
 *           against its upstream: the commits to pull, local changes, NInfer's artifact upgrade tools
 *   update  cp -p <serve> <serve>.gpubench-previous       (the working program, kept aside)
 *           git -C <dir> pull --ff-only
 *           cmake --build <dir>/build -j
 *
 * The update runs after the user has seen these commands and confirmed them. It refuses a checkout with
 * changes to tracked files (a pull could mix them with NInfer's) or with commits of its own. If the build
 * fails or is cancelled, the kept program goes back in place and the checkout returns to the commit it
 * was on (it had no local changes): NInfer keeps working as before.
 */
import path from 'node:path';
import { AppError, isAppError } from '../../../contract/errors';
import { NINFER_CONTAINER_VERSION } from '../../../contract/formats';
import type { LocalModel } from '../../../contract/models';
import { NINFER_SERVE_PATH, type NinferArtifactUpgrade, type NinferCommit, type NinferKind, type NinferUpdateStatus } from '../../../contract/ninfer';
import type { ProgressSink } from '../types';
import { ninferArtifactInfo, type NinferWhere } from './adapter';
import { shellLine, shellQuote, type NinferBuilder } from './build';
import { wslPathOf } from './wsl';

/** The check, in one script: "##key value" lines (git's own output never starts with "##"). */
export const UPDATE_SCRIPT = [
  'start="$1"; [ "${start#\\~}" != "$start" ] && start="$HOME${start#\\~}"',
  'd=$(git -C "$start" rev-parse --show-toplevel 2>/dev/null) || { echo "##nocheckout"; exit 0; }',
  'echo "##dir $d"',
  'GIT_TERMINAL_PROMPT=0 git -C "$d" fetch --quiet 2>/dev/null && echo "##fetched yes"',
  'echo "##head $(git -C "$d" rev-parse HEAD 2>/dev/null)"',
  'echo "##upstream $(git -C "$d" rev-parse --abbrev-ref --symbolic-full-name "@{u}" 2>/dev/null)"',
  'echo "##latest $(git -C "$d" rev-parse "@{u}" 2>/dev/null)"',
  'echo "##counts $(git -C "$d" rev-list --left-right --count "HEAD...@{u}" 2>/dev/null)"',
  'git -C "$d" log -n 20 --format="##commit %H %s" "HEAD..@{u}" 2>/dev/null',
  'git -C "$d" status --porcelain --untracked-files=no 2>/dev/null | head -n 20 | sed "s/^/##dirty /"',
  'for t in "$d"/tools/upgrade_ninfer_v*_to_v*.py; do [ -f "$t" ] && echo "##tool ${t#"$d"/}"; done',
  'exit 0',
].join('\n');

/** The program kept aside before an update, next to it. */
export const KEPT_SUFFIX = '.gpubench-previous';
export const KEEP_SCRIPT = `cp -p "$1" "$1${KEPT_SUFFIX}" && echo "##gpubench-kept"`;
export const DROP_SCRIPT = `rm -f "$1${KEPT_SUFFIX}" && echo "##gpubench-dropped"`;
/** After a failed build: the kept program back, the checkout back on the commit it was on. */
export const RESTORE_SCRIPT = `mv -f "$1${KEPT_SUFFIX}" "$1" && git -C "$2" reset --hard -q "$3" && echo "##gpubench-restored"`;

export interface UpdateReport {
  /** The checkout's top folder; unset when the build is not in a git checkout. */
  dir?: string;
  fetched: boolean;
  head?: string;
  upstream?: string;
  latest?: string;
  ahead: number;
  behind: number;
  commits: NinferCommit[];
  dirty: string[];
  /** NInfer's artifact upgrade tools ("tools/upgrade_ninfer_v2_to_v3.py": from 2 to 3). */
  tools: { path: string; from: number; to: number }[];
}

const SHA = /^[0-9a-f]{7,40}$/;

/** The check script's output. */
export function parseUpdate(stdout: string): UpdateReport {
  const report: UpdateReport = { fetched: false, ahead: 0, behind: 0, commits: [], dirty: [], tools: [] };
  for (const line of stdout.split(/\r?\n/)) {
    const m = /^##([a-z]+) ?(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1] as string;
    const value = (m[2] as string).trim();
    if (key === 'nocheckout') return { fetched: false, ahead: 0, behind: 0, commits: [], dirty: [], tools: [] };
    if (key === 'dir' && value) report.dir = value;
    else if (key === 'fetched') report.fetched = value === 'yes';
    else if (key === 'head' && SHA.test(value)) report.head = value;
    else if (key === 'upstream' && value) report.upstream = value;
    else if (key === 'latest' && SHA.test(value)) report.latest = value;
    else if (key === 'counts') {
      // "ahead<TAB>behind"; nothing when there is no upstream.
      const [ahead, behind] = value.split(/\s+/).map((n) => Number(n) || 0);
      report.ahead = ahead ?? 0;
      report.behind = behind ?? 0;
    } else if (key === 'commit') {
      const c = /^([0-9a-f]{7,40}) ?(.*)$/.exec(value);
      if (c) report.commits.push({ sha: c[1] as string, title: c[2] as string });
    } else if (key === 'dirty' && value) report.dirty.push(value.replace(/^\S+\s+/, ''));
    else if (key === 'tool') {
      const t = /upgrade_ninfer_v(\d+)_to_v(\d+)\.py$/.exec(value);
      if (t) report.tools.push({ path: value, from: Number(t[1]), to: Number(t[2]) });
    }
  }
  return report;
}

/** The update's steps and the lines shown before it (with the restore that follows a failed build). */
export function updateSteps(dir: string, serve: string, from: string | undefined): { steps: { stage: 'pull' | 'build'; argv: string[] }[]; commands: string[]; restore: string[] } {
  const steps = [
    { stage: 'pull' as const, argv: ['git', '-C', dir, 'pull', '--ff-only'] },
    { stage: 'build' as const, argv: ['cmake', '--build', `${dir}/build`, '-j'] },
  ];
  return {
    steps,
    commands: [shellLine(['cp', '-p', serve, `${serve}${KEPT_SUFFIX}`]), ...steps.map((s) => shellLine(s.argv))],
    restore: [shellLine(['mv', '-f', `${serve}${KEPT_SUFFIX}`, serve]), ...(from ? [shellLine(['git', '-C', dir, 'reset', '--hard', from])] : [])],
  };
}

export interface NinferUpdaterOptions {
  kind: NinferKind;
  builder: Pick<NinferBuilder, 'runner' | 'step'>;
  /** The saved build (adapter.where()). */
  where(): Promise<NinferWhere | undefined>;
  /** The library, for the artifacts this build cannot read. */
  models(): Promise<LocalModel[]>;
}

const notConfigured = () => new AppError('ENGINE_NOT_INSTALLED', 'NInfer is not set up', { params: { reason: 'not_configured', kind: 'ninfer' } });
const refuse = (reason: string, message: string, params: Record<string, string | number>) => new AppError('ENGINE_INSTALL_FAILED', message, { params: { reason, ...params } });

export class NinferUpdater {
  constructor(private readonly o: NinferUpdaterOptions) {}

  /** "Controlla aggiornamenti": fetch, then where the checkout stands (nothing else changes). */
  async status(): Promise<NinferUpdateStatus> {
    return (await this.inspect()).status;
  }

  private async inspect(): Promise<{ status: NinferUpdateStatus; where: NinferWhere; report: UpdateReport }> {
    const where = await this.o.where();
    if (!where) throw notConfigured();
    const run = this.o.builder.runner(where.distro);
    const start = where.repo ?? path.posix.dirname(where.serve);
    const out = await run('/bin/sh', ['-c', UPDATE_SCRIPT, 'sh', start], { timeoutMs: 120_000 });
    const report = parseUpdate(out.stdout);
    const dir = report.dir;
    const updatable = dir !== undefined && where.serve === `${dir}/${NINFER_SERVE_PATH}`;
    // What this build reads: the newest container its own upgrade tools write (else the one GPU Bench knows).
    const containerVersion = report.tools.length ? Math.max(...report.tools.map((t) => t.to)) : NINFER_CONTAINER_VERSION;
    const lines = updatable ? updateSteps(dir, where.serve, report.head) : { commands: [], restore: [] };
    const status: NinferUpdateStatus = {
      kind: this.o.kind,
      ...(where.distro ? { distro: where.distro } : {}),
      ...(dir ? { dir } : {}),
      updatable,
      fetched: report.fetched,
      ...(report.head ? { current: report.head } : {}),
      ...(report.upstream ? { upstream: report.upstream } : {}),
      ...(report.latest ? { latest: report.latest } : {}),
      behind: report.behind,
      ahead: report.ahead,
      commits: report.commits,
      dirty: report.dirty,
      commands: lines.commands,
      restore: lines.restore,
      containerVersion,
      artifacts: await this.artifacts(containerVersion, report, where),
    };
    return { status, where, report };
  }

  /** Library artifacts older than `needs`, each with NInfer's upgrade command when it has a tool for that step. */
  private async artifacts(needs: number, report: UpdateReport, where: NinferWhere): Promise<NinferArtifactUpgrade[]> {
    const models = (await this.o.models().catch(() => [])).filter((m) => m.identity.format === 'ninfer' && m.incomplete === undefined);
    const out: NinferArtifactUpgrade[] = [];
    for (const m of models) {
      const info = await ninferArtifactInfo({ identity: m.identity, local: m }).catch(() => undefined);
      const version = info?.manifest?.containerVersion;
      if (version === undefined || version >= needs) continue;
      const file = m.paths.find((p) => /\.ninfer$/i.test(p)) as string;
      const tool = report.tools.find((t) => t.from === version && t.to === needs);
      // The tool runs where NInfer runs: the file as the distro sees it.
      const input = where.distro ? wslPathOf(file, where.distro)?.path : file;
      const command = tool && report.dir && input ? `cd ${shellQuote(report.dir)} && python3 ${shellLine([tool.path, input, input.replace(/\.ninfer$/i, `.v${needs}.ninfer`)])}` : undefined;
      out.push({ id: m.id, name: m.identity.displayName, file, version, needs, ...(command ? { command } : {}) });
    }
    return out;
  }

  /**
   * "Aggiorna": checked again first (a checkout that changed since is refused the same way), then the
   * steps. Returns the program and the commit it now runs.
   */
  async update(progress: ProgressSink, signal: AbortSignal): Promise<{ serve: string; commit?: string }> {
    progress({ stage: 'resolve', bytesDone: 0 });
    const { status, where, report } = await this.inspect();
    if (!status.updatable || !report.dir) throw refuse('ninfer_not_checkout', 'The build is not in a git checkout', { path: where.serve });
    if (status.dirty.length) throw refuse('ninfer_dirty', 'The checkout has local changes', { dir: report.dir, files: status.dirty.join(', ') });
    if (status.ahead > 0) throw refuse('ninfer_ahead', 'The checkout has commits of its own', { dir: report.dir, n: status.ahead });
    if (status.behind === 0) return { serve: where.serve, ...(report.head ? { commit: report.head } : {}) };
    const dir = report.dir;
    const from = report.head as string;
    const run = this.o.builder.runner(where.distro);
    const kept = await run('/bin/sh', ['-c', KEEP_SCRIPT, 'sh', where.serve], { timeoutMs: 120_000 });
    if (!kept.stdout.includes('##gpubench-kept')) {
      throw new AppError('ENGINE_INSTALL_FAILED', 'Cannot keep the current build aside', { params: { reason: 'ninfer_keep', path: where.serve }, detail: kept.stderr.slice(0, 2000) });
    }
    const [pull, build] = updateSteps(dir, where.serve, from).steps as [{ stage: 'pull'; argv: string[] }, { stage: 'build'; argv: string[] }];
    const drop = () => run('/bin/sh', ['-c', DROP_SCRIPT, 'sh', where.serve], { timeoutMs: 60_000 }).catch(() => undefined);
    try {
      await this.o.builder.step(pull.stage, pull.argv, where.distro, progress, signal);
    } catch (e) {
      // Nothing changed but the copy: it goes.
      await drop();
      throw e;
    }
    try {
      await this.o.builder.step(build.stage, build.argv, where.distro, progress, signal);
    } catch (e) {
      const back = await run('/bin/sh', ['-c', RESTORE_SCRIPT, 'sh', where.serve, dir, from], { timeoutMs: 120_000 }).catch(() => undefined);
      const restored = back?.stdout.includes('##gpubench-restored') === true;
      const err = isAppError(e) ? e : new AppError('ENGINE_INSTALL_FAILED', String(e));
      throw new AppError(err.code, err.message, { params: { ...err.params, reason: 'ninfer_update', restored, commit: from.slice(0, 12) }, ...(err.detail ? { detail: err.detail } : {}), cause: e });
    }
    await drop();
    return { serve: where.serve, ...(status.latest ? { commit: status.latest } : {}) };
  }
}
