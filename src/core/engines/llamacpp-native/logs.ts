import { AppError } from '../../../contract/errors';
import type { ExitInfo } from '../../deps';

/**
 * Load phases of llama-server, detected from its (stderr) log. Each mark is the first line of
 * a phase; a phase ends where the next one starts, the last one at "ready" (/health 200).
 *
 *   model_load    srv load_model: loading model '…'   (GGUF header/metadata, device selection)
 *   load_tensors  load_tensors: loading model tensors… / offloaded N/N layers to GPU
 *                 → disk read + upload of the weights: the cold-read estimate uses this phase
 *   context       llama_context: constructing llama_context (KV cache + compute buffers)
 *   warmup        common_init_from_params: warming up the model with an empty run
 *   listening     main: server is listening on http://127.0.0.1:PORT
 *
 * Patterns are not anchored: `--log-prefix` / `--log-timestamps` add a prefix to every line.
 */
export const LLAMA_PHASES: readonly { name: string; re: RegExp }[] = [
  { name: 'model_load', re: /\bload_model: loading model\b|\bllama_model_loader: loaded meta data\b/ },
  { name: 'load_tensors', re: /\bload_tensors:/ },
  { name: 'context', re: /\bllama_context:|\bllama_init_from_model:/ },
  { name: 'warmup', re: /\bwarming up the model\b/ },
  { name: 'listening', re: /\bserver is listening on\b/ },
];

export function llamaPhaseOf(text: string): string | undefined {
  return LLAMA_PHASES.find((p) => p.re.test(text))?.name;
}

const OOM = [
  /cudaMalloc failed: out of memory/i,
  /CUDA error: out of memory/i,
  /\bout of memory\b/i,
  /failed to allocate/i,
  /unable to allocate .*buffer/i,
  /alloc_buffer: allocating .* failed/i,
];
const SPAWN = /^Error: spawn .*\b(ENOENT|EACCES|EPERM|EINVAL|UNKNOWN)\b/;
const NO_KERNEL = /no kernel image is available/i;
const BAD_FLAG = [
  /error: invalid argument: (\S+)/,
  /error: unknown argument: (\S+)/,
  /unknown argument: (\S+)/,
  /error while handling argument "([^"]+)"/,
  /error: (?:the )?argument (\S+) (?:requires|expected)/,
];
const PORT = /couldn't bind|address already in use|bind failed|failed to bind/i;
const MODEL = /failed to load model|error loading model|failed to open GGUF file|gguf_init_from_file.*failed/i;

/** Last lines kept in AppError.detail (shown under "Dettagli"). */
const DETAIL_LINES = 25;

/** Turns an early exit into the most specific error the log supports. Order matters: an OOM also logs "failed to load model". */
export function diagnoseExit(lines: readonly string[], exit: ExitInfo): AppError {
  const detail = lines.slice(-DETAIL_LINES).join('\n');
  const find = (re: RegExp) => lines.find((l) => re.test(l));
  const params: Record<string, string | number> = { code: String(exit.code ?? exit.signal) };

  // The runner reports a failed spawn (missing file, no exec permission) as an error line.
  const spawnError = find(SPAWN);
  if (spawnError !== undefined) return new AppError('ENGINE_START_FAILED', spawnError.trim(), { params, detail });

  const oom = OOM.map(find).find((l) => l !== undefined);
  if (oom !== undefined) return new AppError('ENGINE_OOM', `Out of GPU memory: ${oom.trim()}`, { params, detail });

  const noKernel = find(NO_KERNEL);
  if (noKernel !== undefined) {
    return new AppError('ENGINE_NO_KERNEL_IMAGE', 'The engine build does not support this GPU', { params, detail });
  }
  for (const re of BAD_FLAG) {
    const line = find(re);
    const flag = line === undefined ? undefined : re.exec(line)?.[1];
    if (flag !== undefined) {
      return new AppError('ENGINE_BAD_FLAG', `Rejected argument: ${flag}`, { params: { ...params, flag }, detail });
    }
  }
  if (find(PORT) !== undefined) return new AppError('ENGINE_PORT_IN_USE', 'The port is already in use', { params, detail });
  const model = find(MODEL);
  if (model !== undefined) return new AppError('MODEL_INVALID', `Model failed to load: ${model.trim()}`, { params, detail });
  return new AppError('ENGINE_EXITED', `Engine exited with ${params.code}`, { params, detail });
}
