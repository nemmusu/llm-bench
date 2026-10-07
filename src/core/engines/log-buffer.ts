/**
 * Engine log kept as head + tail: the start of an engine (what it loaded, how it sized the context,
 * up to "ready") is what diagnoses a run, and request lines must never push it out.
 */

/** Lines kept from the start of an engine log (fewer when the engine is ready sooner). */
export const LOG_HEAD_LINES = 80;

/** The line standing for lines dropped between a log's head and its tail. */
export function omittedLine(n: number): string {
  return n === 1 ? '… 1 riga omessa …' : `… ${n} righe omesse …`;
}

const OMITTED = /^… (\d+) (?:righe omesse|riga omessa) …$/;

/** How many lines an omitted-lines marker stands for, or undefined when `line` is not one. */
export function omittedCount(line: string): number | undefined {
  const m = OMITTED.exec(line);
  return m ? Number(m[1]) : undefined;
}

/**
 * The first lines until the head is closed (ready) or full, then a bounded tail. lines() puts an
 * omitted-lines marker between them when the tail dropped anything.
 */
export class HeadTailLog {
  private readonly head: string[] = [];
  private readonly tail: string[] = [];
  private headOpen = true;
  private omitted = 0;

  constructor(
    private readonly maxTail: number,
    private readonly maxHead = LOG_HEAD_LINES,
  ) {}

  push(line: string): void {
    if (this.headOpen && this.head.length < this.maxHead) {
      this.head.push(line);
      return;
    }
    this.tail.push(line);
    if (this.tail.length > this.maxTail) {
      this.tail.shift();
      this.omitted++;
    }
  }

  /** The engine is ready: later lines belong to the tail. */
  closeHead(): void {
    this.headOpen = false;
  }

  lines(): string[] {
    return [...this.head, ...(this.omitted > 0 ? [omittedLine(this.omitted)] : []), ...this.tail];
  }
}
