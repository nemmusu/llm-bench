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

/** koboldcpp ships per-backend builds: koboldcpp_cu12.exe, koboldcpp-linux-x64-cuda1210… */
const KNOWN_LLM_PATTERNS: readonly RegExp[] = [/^koboldcpp[_-]/];

/** Last path segment of a Windows or POSIX path (nvidia-smi reports full paths on both). */
export function processBaseName(processName: string): string {
  const trimmed = processName.trim();
  const parts = trimmed.split(/[\\/]/);
  return parts[parts.length - 1] || trimmed;
}

export function isKnownLlm(processName: string): boolean {
  const base = processBaseName(processName)
    .toLowerCase()
    .replace(/\.exe$/, '');
  return KNOWN_LLM_NAMES.has(base) || KNOWN_LLM_PATTERNS.some((re) => re.test(base));
}
