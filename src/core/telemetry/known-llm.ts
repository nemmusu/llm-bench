import type { GpuUserKind } from './types';

/**
 * Recognizes well-known LLM servers among GPU processes, by executable base name only
 * (case-insensitive, with or without .exe). Generic interpreters (python, node…) are never
 * "known": we cannot tell a vLLM worker from any other script without reading its command line.
 */
const KNOWN_LLM_NAMES: ReadonlySet<string> = new Set([
  'llama-server',
  'llama-cli',
  'llama-bench',
  'ollama',
  'ollama_llama_server',
  'lms',
  'lm studio',
  'lm-studio',
  'koboldcpp',
  'text-generation-launcher',
  'text-generation-server',
  'tabbyapi',
  'sglang',
  'vllm',
]);

/**
 * koboldcpp ships per-backend builds: koboldcpp_cu12.exe, koboldcpp-linux-x64-cuda1210…
 * vLLM renames its processes (setproctitle), which nvidia-smi shows on Linux: VLLM::EngineCore, VLLM::Worker_TP0.
 */
const KNOWN_LLM_PATTERNS: readonly RegExp[] = [/^koboldcpp[_-]/, /^vllm::/];

/** Last path segment of a Windows or POSIX path (nvidia-smi reports full paths on both). */
export function processBaseName(processName: string): string {
  const trimmed = processName.trim();
  const parts = trimmed.split(/[\\/]/);
  return parts[parts.length - 1] || trimmed;
}

/** Lower-case base name without ".exe": the key every name list below is written in. */
function normalizedName(processName: string): string {
  return processBaseName(processName)
    .toLowerCase()
    .replace(/\.exe$/, '');
}

export function isKnownLlm(processName: string): boolean {
  const base = normalizedName(processName);
  return KNOWN_LLM_NAMES.has(base) || KNOWN_LLM_PATTERNS.some((re) => re.test(base));
}

/**
 * Virtual machines whose GPU memory belongs to programs running inside them: WSL 2 and Hyper-V
 * (vmwp, vmmem, vmmemWSL), Docker Desktop (which runs its engine in the same WSL VM).
 */
const VM_NAMES: ReadonlySet<string> = new Set(['vmwp', 'vmmem', 'vmmemwsl', 'vmcompute', 'docker desktop', 'com.docker.virtualization']);

/** The desktop itself (Windows shell and compositor, Linux compositors): always there, never "sharing" the GPU. */
const SYSTEM_NAMES: ReadonlySet<string> = new Set([
  // Windows
  'system',
  'registry',
  'dwm',
  'csrss',
  'winlogon',
  'logonui',
  'lockapp',
  'explorer',
  'searchhost',
  'searchapp',
  'searchui',
  'textinputhost',
  'tabtip',
  'shellexperiencehost',
  'startmenuexperiencehost',
  'applicationframehost',
  'shellhost',
  'sihost',
  'fontdrvhost',
  'ctfmon',
  'runtimebroker',
  'svchost',
  'widgets',
  'widgetservice',
  'crossdeviceresume',
  'systemsettings',
  'taskmgr',
  'nvidia overlay',
  'nvcontainer',
  // Linux
  'xorg',
  'xwayland',
  'gnome-shell',
  'kwin',
  'kwin_x11',
  'kwin_wayland',
  'plasmashell',
  'mutter',
  'sway',
  'weston',
  'hyprland',
  'cinnamon',
  'xfwm4',
  'compiz',
  'picom',
]);

/** Classifies a GPU process by executable name (path or bare name, with or without .exe). */
export function gpuUserKind(processName: string): GpuUserKind {
  if (isKnownLlm(processName)) return 'llm';
  const base = normalizedName(processName);
  if (VM_NAMES.has(base)) return 'vm';
  if (SYSTEM_NAMES.has(base)) return 'system';
  return 'app';
}
