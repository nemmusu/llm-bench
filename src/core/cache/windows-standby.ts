import type { CoreDeps } from '../deps';
import type { CacheEvictor, EvictResult } from './evictor';

/**
 * Windows has no per-file "drop from cache": a model's pages sit in the standby list after the
 * engine exits. Purging the standby list needs SeProfileSingleProcessPrivilege (admin), so the user
 * can opt in once: one UAC prompt registers a scheduled task that runs as SYSTEM.
 *
 * Security design:
 *  - The purge script is embedded in the task definition (-EncodedCommand). There is no file on
 *    disk that runs elevated, so nothing user-writable can be swapped in.
 *  - The task takes no arguments and writes nothing; its only effect is emptying the standby list
 *    (a performance-only effect). Authenticated users may start it (GRGX), nobody but admins may
 *    change it.
 *  - The app reads the outcome from Get-ScheduledTaskInfo (LastRunTime / LastTaskResult).
 */

/**
 * The task's folder keeps the app's old name (GPU Bench, before 0.4.0): tasks registered by older
 * versions keep working and are found and removed by this one. The UI names only the task.
 */
export const TASK_FOLDER = '\\GPU Bench\\';
export const TASK_NAME = 'PurgeStandby';

/** Runs elevated inside the task: enable the privilege, purge, exit 0 on success. */
export const PURGE_SCRIPT = `$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class GpuBenchPurge {
  [StructLayout(LayoutKind.Sequential, Pack = 1)]
  struct TokPriv1Luid { public int Count; public long Luid; public int Attr; }
  [DllImport("advapi32.dll", SetLastError = true)]
  static extern bool OpenProcessToken(IntPtr h, int acc, out IntPtr tok);
  [DllImport("advapi32.dll", SetLastError = true)]
  static extern bool LookupPrivilegeValue(string host, string name, ref long luid);
  [DllImport("advapi32.dll", SetLastError = true)]
  static extern bool AdjustTokenPrivileges(IntPtr tok, bool disableAll, ref TokPriv1Luid state, int len, IntPtr prev, IntPtr relen);
  [DllImport("kernel32.dll")]
  static extern IntPtr GetCurrentProcess();
  [DllImport("ntdll.dll")]
  static extern uint NtSetSystemInformation(int infoClass, ref int info, int length);
  public static uint Purge() {
    IntPtr tok;
    if (!OpenProcessToken(GetCurrentProcess(), 0x28, out tok)) return 0xE0000001;
    long luid = 0;
    if (!LookupPrivilegeValue(null, "SeProfileSingleProcessPrivilege", ref luid)) return 0xE0000002;
    var tp = new TokPriv1Luid { Count = 1, Luid = luid, Attr = 2 };
    if (!AdjustTokenPrivileges(tok, false, ref tp, 0, IntPtr.Zero, IntPtr.Zero)) return 0xE0000003;
    int command = 4; // MemoryPurgeStandbyList
    return NtSetSystemInformation(80, ref command, 4); // SystemMemoryListInformation
  }
}
"@
$status = [GpuBenchPurge]::Purge()
if ($status -ne 0) { exit 1 }
exit 0`;

/** PowerShell -EncodedCommand payload: base64 of UTF-16LE. */
export function encodePowerShell(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64');
}

/** Elevated (UAC) script that registers the task. */
export function installScript(): string {
  const args = `-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -EncodedCommand ${encodePowerShell(PURGE_SCRIPT)}`;
  return `$ErrorActionPreference = 'Stop'
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument '${args}'
$principal = New-ScheduledTaskPrincipal -UserId 'S-1-5-18' -LogonType ServiceAccount -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 2) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskPath '${TASK_FOLDER}' -TaskName '${TASK_NAME}' -Action $action -Principal $principal -Settings $settings -Force | Out-Null
$svc = New-Object -ComObject Schedule.Service
$svc.Connect()
$task = $svc.GetFolder('${TASK_FOLDER.replace(/\\$/, '')}').GetTask('${TASK_NAME}')
$sd = $task.GetSecurityDescriptor(4)
if ($sd -notmatch ';;;AU\\)') { $task.SetSecurityDescriptor($sd + '(A;;GRGX;;;AU)', 0) }`;
}

/** Elevated (UAC) script that removes the task and its folder. */
export function uninstallScript(): string {
  return `$ErrorActionPreference = 'SilentlyContinue'
Unregister-ScheduledTask -TaskPath '${TASK_FOLDER}' -TaskName '${TASK_NAME}' -Confirm:$false
$svc = New-Object -ComObject Schedule.Service
$svc.Connect()
$svc.GetFolder('\\').DeleteFolder('${TASK_FOLDER.replace(/\\/g, '')}', 0)
exit 0`;
}

/** Wraps a script so it runs in an elevated PowerShell after the user accepts the UAC prompt. */
export function elevatedArgs(script: string): string[] {
  const inner = encodePowerShell(script);
  const outer = `$p = Start-Process -FilePath 'powershell.exe' -Verb RunAs -Wait -PassThru -WindowStyle Hidden -ArgumentList '-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-EncodedCommand','${inner}'; exit $p.ExitCode`;
  return ['-NoProfile', '-NonInteractive', '-Command', outer];
}

export interface TaskInfo {
  installed: boolean;
  /** ms since epoch of the last run start, if any. */
  lastRun?: number;
  /** Win32/HRESULT result of the last run; 0 = success, 0x41301 (267009) = still running. */
  lastResult?: number;
}

export const TASK_RUNNING = 267009;

/** Parses the JSON printed by the query script below. */
export function parseTaskInfo(stdout: string): TaskInfo {
  const text = stdout.trim();
  if (!text) return { installed: false };
  let raw: { LastRunTime?: string | null; LastTaskResult?: number | null };
  try {
    raw = JSON.parse(text) as typeof raw;
  } catch {
    return { installed: false };
  }
  const info: TaskInfo = { installed: true };
  const lastRun = raw.LastRunTime ? Date.parse(raw.LastRunTime) : NaN;
  if (Number.isFinite(lastRun) && lastRun > 0) info.lastRun = lastRun;
  if (typeof raw.LastTaskResult === 'number') info.lastResult = raw.LastTaskResult;
  return info;
}

const QUERY_SCRIPT = `$i = Get-ScheduledTaskInfo -TaskPath '${TASK_FOLDER}' -TaskName '${TASK_NAME}' -ErrorAction SilentlyContinue
if ($i) { [pscustomobject]@{ LastRunTime = if ($i.LastRunTime) { $i.LastRunTime.ToUniversalTime().ToString('o') } else { $null }; LastTaskResult = $i.LastTaskResult } | ConvertTo-Json -Compress }`;

const PS = 'powershell.exe';
const psArgs = (script: string) => ['-NoProfile', '-NonInteractive', '-Command', script];

export class WindowsStandbyEvictor implements CacheEvictor {
  readonly kind = 'windows-standby' as const;

  constructor(
    private readonly deps: Pick<CoreDeps, 'proc' | 'clock'>,
    private readonly opts: { pollMs?: number; timeoutMs?: number } = {},
  ) {}

  async info(): Promise<TaskInfo> {
    const r = await this.deps.proc.run(PS, psArgs(QUERY_SCRIPT), { timeoutMs: 20_000 });
    return r.code === 0 ? parseTaskInfo(r.stdout) : { installed: false };
  }

  /** Shows the UAC prompt. Resolves false when the user declines it or registration fails. */
  async install(): Promise<boolean> {
    const r = await this.deps.proc.run(PS, elevatedArgs(installScript()), { timeoutMs: 180_000 });
    return r.code === 0 && (await this.info()).installed;
  }

  async uninstall(): Promise<boolean> {
    const r = await this.deps.proc.run(PS, elevatedArgs(uninstallScript()), { timeoutMs: 180_000 });
    return r.code === 0 && !(await this.info()).installed;
  }

  async evict(_files: string[], signal?: AbortSignal): Promise<EvictResult> {
    const before = await this.info();
    if (!before.installed) return { guaranteed: false, reason: 'not-enabled' };
    // Task Scheduler stores LastRunTime with second precision.
    const requested = this.deps.clock.wall() - 1500;
    const start = await this.deps.proc.run(PS, psArgs(`Start-ScheduledTask -TaskPath '${TASK_FOLDER}' -TaskName '${TASK_NAME}'`), {
      timeoutMs: 20_000,
    });
    if (start.code !== 0) return { guaranteed: false, reason: 'failed' };
    const deadline = this.deps.clock.now() + (this.opts.timeoutMs ?? 60_000);
    while (this.deps.clock.now() < deadline) {
      await this.deps.clock.sleep(this.opts.pollMs ?? 500, signal);
      const info = await this.info();
      if (info.lastRun !== undefined && info.lastRun >= requested && info.lastResult !== TASK_RUNNING) {
        return info.lastResult === 0 ? { guaranteed: true } : { guaranteed: false, reason: 'failed' };
      }
    }
    return { guaranteed: false, reason: 'timeout' };
  }
}
