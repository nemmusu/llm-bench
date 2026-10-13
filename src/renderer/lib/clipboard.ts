import { toast } from 'sonner';

/** Copies `text`, then says so (or that it failed) in a toast. */
export async function copyText(text: string, done: string, failed: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(done);
  } catch {
    toast.error(failed);
  }
}
