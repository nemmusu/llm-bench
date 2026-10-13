/**
 * NInfer's "Aggiorna" (contract/engine-updates.ts, targets 'ninfer-native' / 'ninfer-wsl'), on Linux
 * or inside the chosen WSL distro, and only inside NInfer's git checkout:
 *
 *   check   one script: where HEAD stands against its upstream branch (after `git fetch` when asked:
 *           only the checkout's remote-tracking branches change), the new commits with their titles,
 *           local changes, NInfer's artifact upgrade tools, git and cmake there at all
 *   update  cp -p <serve> <serve>.gpubench-previous       (the working program, kept aside)
 *           git -C <dir> pull --ff-only
 *           cmake --build <dir>/build -j
 *
 * The same shapes and reasons as the other engines' updates (core/engines/updates); what NInfer adds
 * is the way back: if the build fails or is cancelled, the kept program goes back in place and the
 * checkout returns to the commit it was on (it had no local changes), so NInfer keeps working. Each
 * step runs as NInfer's guided build runs its steps (WSL: in its own session, marked as ours, so a
 * cancel stops the compile inside the distro). Library artifacts in an older container version than
 * this build reads are listed with NInfer's own upgrade command.
 */
import path from 'node:path';
import type { EngineUpdateCheck } from '../../../contract/engine-updates';
import { AppError, isAppError } from '../../../contract/errors';
import { NINFER_CONTAINER_VERSION } from '../../../contract/formats';
import type { LocalModel } from '../../../contract/models';
import { NINFER_SERVE_PATH, type NinferArtifactUpgrade, type NinferKind } from '../../../contract/ninfer';
import type { UpdateProgress } from '../updates/service';
import { ninferArtifactInfo, type NinferWhere } from './adapter';
import { shellLine, shellQuote, type NinferBuilder } from './build';
import { wslPathOf } from './wsl';

/** The check, in one script: "##key value" lines (git's own output never starts with "##"). `$2` = 1: fetch first. */
export const UPDATE_SCRIPT = [
  'start="$1"; [ "${start#\\~}" != "$start" ] && start="$HOME${start#\\~}"',
  'command -v git >/dev/null 2>&1 || { echo "##nogit"; exit 0; }',
  'd=$(git -C "$start" rev-parse --show-toplevel 2>/dev/null) || { echo "##nocheckout"; exit 0; }',
  'echo "##dir $d"',
  'if [ "$2" = 1 ]; then',
  '  if out=$(GIT_TERMINAL_PROMPT=0 git -C "$d" fetch --quiet 2>&1); then echo "##fetched yes"; else echo "##fetched no"; printf "%s\\n" "$out" | tail -n 8 | sed "s/^/##fetcherr /"; fi',
  'fi',
  'echo "##head $(git -C "$d" rev-parse HEAD 2>/dev/null)"',
  'echo "##branch $(git -C "$d" rev-parse --abbrev-ref HEAD 2>/dev/null)"',
  'echo "##upstream $(git -C "$d" rev-parse --abbrev-ref --symbolic-full-name "@{u}" 2>/dev/null)"',
  'echo "##latest $(git -C "$d" rev-parse "@{u}" 2>/dev/null)"',
  'echo "##counts $(git -C "$d" rev-list --left-right --count "HEAD...@{u}" 2>/dev/null)"',
  'git -C "$d" log -n 20 --format="##commit %H %s" "HEAD..@{u}" 2>/dev/null',
  'git -C "$d" status --porcelain --untracked-files=no 2>/dev/null | head -n 20 | sed "s/^/##dirty /"',
  'for t in "$d"/tools/upgrade_ninfer_v*_to_v*.py; do [ -f "$t" ] && echo "##tool ${t#"$d"/}"; done',
  'echo "##cmake $(command -v cmake)"',
  'exit 0',
].join('\n');

/** The program kept aside before an update, next to it. */
export const KEPT_SUFFIX = '.gpubench-previous';
export const KEEP_SCRIPT = `cp -p "$1" "$1${KEPT_SUFFIX}" && echo "##gpubench-kept"`;
export const DROP_SCRIPT = `rm -f "$1${KEPT_SUFFIX}" && echo "##gpubench-dropped"`;
/** After a failed build: the kept program back, the checkout back on the commit it was on. */
export const RESTORE_SCRIPT = `mv -f "$1${KEPT_SUFFIX}" "$1" && git -C "$2" reset --hard -q "$3" && echo "##gpubench-restored"`;

export interface UpdateReport {
  /** git is there at all. */
  git: boolean;
  /** The checkout's top folder; unset when the build is not in a git checkout. */
  dir?: string;
  /** The fetch, when asked: true, false (its last lines in fetchError), undefined = not asked. */
  fetched?: boolean;
  fetchError?: string;
  head?: string;
  branch?: string;
  upstream?: string;
  latest?: string;
  ahead: number;
  behind: number;
  commits: { sha: string; title: string }[];
  dirty: string[];
  /** NInfer's artifact upgrade tools ("tools/upgrade_ninfer_v2_to_v3.py": from 2 to 3). */
  tools: { path: string; from: number; to: number }[];
  cmake: boolean;
}

const SHA = /^[0-9a-f]{7,40}$/;
const short = (sha: string | undefined): string | undefined => sha?.slice(0, 7);

/** The check script's output. */
export function parseUpdate(stdout: string): UpdateReport {
  const report: UpdateReport = { git: true, ahead: 0, behind: 0, commits: [], dirty: [], tools: [], cmake: false };
  const fetchError: string[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const m = /^##([a-z]+) ?(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1] as string;
    const value = (m[2] as string).trim();
    if (key === 'nogit') return { ...report, git: false };
    if (key === 'nocheckout') return { git: true, ahead: 0, behind: 0, commits: [], dirty: [], tools: [], cmake: false };
    if (key === 'dir' && value) report.dir = value;
    else if (key === 'fetched') report.fetched = value === 'yes';
    else if (key === 'fetcherr' && value) fetchError.push(value);
    else if (key === 'head' && SHA.test(value)) report.head = value;
    else if (key === 'branch' && value) report.branch = value;
    else if (key === 'upstream' && value) report.upstream = value;
    else if (key === 'latest' && SHA.test(value)) report.latest = value;
    else if (key === 'counts') {
      // "ahead<TAB>behind"; nothing when there is no upstream.
      const counts = value.split(/\s+/).map((n) => Number(n) || 0);
      report.ahead = counts[0] as number;
      report.behind = counts[1] ?? 0;
    } else if (key === 'commit') {
      const c = /^([0-9a-f]{7,40}) ?(.*)$/.exec(value);
      if (c) report.commits.push({ sha: c[1] as string, title: c[2] as string });
    } else if (key === 'dirty' && value) report.dirty.push(value.replace(/^\S+\s+/, ''));
    else if (key === 'tool') {
      const t = /upgrade_ninfer_v(\d+)_to_v(\d+)\.py$/.exec(value);
      if (t) report.tools.push({ path: value, from: Number(t[1]), to: Number(t[2]) });
    } else if (key === 'cmake') report.cmake = value !== '';
  }
  if (fetchError.length) report.fetchError = fetchError.join('\n');
  return report;
}

/** The update's steps, and the commands shown before it (with the restore that follows a failed build). */
export function updateSteps(dir: string, serve: string, from: string | undefined): { steps: { stage: 'git-pull' | 'build'; argv: string[] }[]; commands: string[][]; restore: string[][] } {
  const steps = [
    { stage: 'git-pull' as const, argv: ['git', '-C', dir, 'pull', '--ff-only'] },
    { stage: 'build' as const, argv: ['cmake', '--build', `${dir}/build`, '-j'] },
  ];
  return {
    steps,
    commands: [['cp', '-p', serve, `${serve}${KEPT_SUFFIX}`], ...steps.map((s) => s.argv)],
    restore: [['mv', '-f', `${serve}${KEPT_SUFFIX}`, serve], ...(from ? [['git', '-C', dir, 'reset', '--hard', from]] : [])],
  };
}

export interface NinferUpdaterOptions {
  kind: NinferKind;
  builder: Pick<NinferBuilder, 'runner' | 'step'>;
  /** The saved build (adapter.where()). */
  where(): Promise<NinferWhere | undefined>;
  /** The library, for the artifacts this build cannot read. */
  models(): Promise<LocalModel[]>;
  /** The rebuilt program answers (a fresh probe of the build). */
  verify(): Promise<boolean>;
  /** A guided build of NInfer is running (the same checkout, the same compiler). */
  building?(): boolean;
  clock: { wall(): number };
}

/** An update ready to run: resolves with the commit it installed. */
export type NinferUpdateRun = (progress: (p: UpdateProgress) => void, signal: AbortSignal) => Promise<string>;

const failed = (reason: string, message: string, params: Record<string, string | number | boolean> = {}, detail?: string) =>
  new AppError('ENGINE_UPDATE_FAILED', message, { params: { reason, ...params }, ...(detail ? { detail } : {}) });

export class NinferUpdater {
  constructor(private readonly o: NinferUpdaterOptions) {}

  /** The check of "Controlla aggiornamenti" (`fetch`: ask the remote again), and the update it offers. */
  async plan(opts: { fetch?: boolean } = {}): Promise<{ check: EngineUpdateCheck; run?: NinferUpdateRun }> {
    const where = await this.o.where();
    const base: EngineUpdateCheck = {
      target: this.o.kind,
      method: 'git',
      state: 'blocked',
      commands: [],
      checkedAt: new Date(this.o.clock.wall()).toISOString(),
      ...(where?.distro ? { distro: where.distro } : {}),
    };
    if (!where) return { check: { ...base, reason: 'not-installed' } };
    const run = this.o.builder.runner(where.distro);
    const start = where.repo ?? path.posix.dirname(where.serve);
    const out = await run('/bin/sh', ['-c', UPDATE_SCRIPT, 'sh', start, opts.fetch ? '1' : '0'], { timeoutMs: 120_000 });
    const r = parseUpdate(out.stdout);
    if (!r.git) return { check: { ...base, reason: 'git-missing' } };
    // What this build reads: the newest container its own upgrade tools write (else the one GPU Bench knows).
    const containerVersion = r.tools.length ? Math.max(...r.tools.map((t) => t.to)) : NINFER_CONTAINER_VERSION;
    const ninfer = { containerVersion, artifacts: await this.artifacts(containerVersion, r, where) };
    const dir = r.dir;
    // Built somewhere else than <checkout>/build/apps/ninfer-serve: updated with its own tools.
    if (dir === undefined || where.serve !== `${dir}/${NINFER_SERVE_PATH}`) return { check: { ...base, method: 'none', state: 'none', reason: 'tools', ninfer } };
    const lines = updateSteps(dir, where.serve, r.head);
    const at: EngineUpdateCheck = {
      ...base,
      repo: dir,
      buildDir: `${dir}/build`,
      commands: lines.commands,
      restore: lines.restore,
      ...(r.branch ? { branch: r.branch } : {}),
      ...(r.head ? { current: short(r.head) } : {}),
      ...(r.latest ? { latest: short(r.latest) } : {}),
      ninfer,
    };
    if (this.o.building?.()) return { check: { ...at, reason: 'busy' } };
    if (r.branch === 'HEAD') return { check: { ...at, reason: 'detached' } };
    if (!r.upstream) return { check: { ...at, reason: 'no-upstream' } };
    if (r.fetched === false) return { check: { ...at, reason: 'fetch-failed', ...(r.fetchError ? { detail: r.fetchError } : {}) } };
    if (r.dirty.length) return { check: { ...at, reason: 'dirty', changed: r.dirty.length, commits: r.behind } };
    if (r.behind === 0) return { check: { ...at, state: 'current' } };
    if (r.ahead > 0) return { check: { ...at, reason: 'diverged', commits: r.behind } };
    if (!r.cmake) return { check: { ...at, reason: 'cmake-missing', commits: r.behind } };
    const log = r.commits.map((c) => ({ sha: c.sha.slice(0, 7), title: c.title }));
    return {
      check: { ...at, state: 'available', commits: r.behind, log },
      run: (progress, signal) => this.run(where, dir, r, progress, signal),
    };
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

  /** "Aggiorna": the checked plan run (the routes check again right before). Resolves with the new commit. */
  async update(progress: (p: UpdateProgress) => void, signal: AbortSignal): Promise<{ version?: string }> {
    const { check, run } = await this.plan();
    if (!run) throw failed(check.reason ?? check.state, `Nothing to update for ${this.o.kind}`, check.changed !== undefined ? { changed: check.changed } : {});
    return { version: await run(progress, signal) };
  }

  private async run(where: NinferWhere, dir: string, r: UpdateReport, progress: (p: UpdateProgress) => void, signal: AbortSignal): Promise<string> {
    const from = r.head as string;
    const exec = this.o.builder.runner(where.distro);
    const kept = await exec('/bin/sh', ['-c', KEEP_SCRIPT, 'sh', where.serve], { timeoutMs: 120_000 });
    if (!kept.stdout.includes('##gpubench-kept')) throw failed('ninfer_keep', 'Cannot keep the current build aside', { path: where.serve }, kept.stderr.slice(0, 2000));
    const [pull, build] = updateSteps(dir, where.serve, from).steps as [{ stage: 'git-pull'; argv: string[] }, { stage: 'build'; argv: string[] }];
    // The guided build's steps report steps as bytes: here they are steps.
    const sink = (p: { stage: string; bytesDone: number; bytesTotal?: number }) => progress({ stage: p.stage, bytesDone: 0, ...(p.bytesTotal !== undefined ? { step: p.bytesDone, steps: p.bytesTotal } : {}) });
    const drop = () => exec('/bin/sh', ['-c', DROP_SCRIPT, 'sh', where.serve], { timeoutMs: 60_000 }).catch(() => undefined);
    const asUpdate = (e: unknown, reason: string, extra: Record<string, string | number | boolean> = {}) => {
      const err = isAppError(e) ? e : new AppError('ENGINE_UPDATE_FAILED', String(e));
      const code = err.code === 'CANCELLED' ? 'CANCELLED' : 'ENGINE_UPDATE_FAILED';
      return new AppError(code, err.message, { params: { ...err.params, reason, ...extra }, ...(err.detail ? { detail: err.detail } : {}), cause: e });
    };
    try {
      await this.o.builder.step(pull.stage, pull.argv, where.distro, sink, signal);
    } catch (e) {
      // Nothing changed but the copy: it goes.
      await drop();
      throw asUpdate(e, 'git');
    }
    try {
      await this.o.builder.step(build.stage, build.argv, where.distro, sink, signal);
    } catch (e) {
      const back = await exec('/bin/sh', ['-c', RESTORE_SCRIPT, 'sh', where.serve, dir, from], { timeoutMs: 120_000 }).catch(() => undefined);
      throw asUpdate(e, 'cmake', { restored: back?.stdout.includes('##gpubench-restored') === true, commit: from.slice(0, 7) });
    }
    await drop();
    progress({ stage: 'verify', bytesDone: 0 });
    // The new build must answer like the old one did (its help, through the engine's own check).
    if (!(await this.o.verify())) throw failed('verify', 'The rebuilt NInfer does not start');
    return short(r.latest) as string;
  }
}
