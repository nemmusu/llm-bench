import { describe, expect, it } from 'vitest';
import { buildLogExcerpt, LOG_EXCERPT_BYTES, LOG_EXCERPT_LINES } from '../../../../src/core/bench/runner';
import { HeadTailLog, LOG_HEAD_LINES, omittedCount, omittedLine } from '../../../../src/core/engines/log-buffer';

const range = (prefix: string, n: number, from = 0) => Array.from({ length: n }, (_, i) => `${prefix}${from + i}`);

describe('HeadTailLog', () => {
  it('keeps the head until ready (or full), then a bounded tail with a marker', () => {
    const log = new HeadTailLog(2, 3);
    for (const l of ['a', 'b']) log.push(l);
    log.closeHead();
    for (const l of ['c', 'd', 'e', 'f']) log.push(l);
    expect(log.lines()).toEqual(['a', 'b', '… 2 righe omesse …', 'e', 'f']);
    const full = new HeadTailLog(5, 2);
    for (const l of ['a', 'b', 'c']) full.push(l);
    expect(full.lines()).toEqual(['a', 'b', 'c']);
  });

  it('marker text and parsing', () => {
    expect(omittedLine(1)).toBe('… 1 riga omessa …');
    expect(omittedLine(1234)).toBe('… 1234 righe omesse …');
    expect(omittedCount('… 1 riga omessa …')).toBe(1);
    expect(omittedCount('… 1234 righe omesse …')).toBe(1234);
    expect(omittedCount('righe omesse')).toBeUndefined();
  });
});

describe('buildLogExcerpt', () => {
  it('keeps everything that fits', () => {
    const text = buildLogExcerpt([{ label: 'warm-load 1', lines: ['a', 'b'] }], ['note']);
    expect(text).toBe('=== warm-load 1 ===\na\nb\n=== llm-bench ===\nnote');
    expect(buildLogExcerpt([], [])).toBe('');
  });

  it('keeps the start of every engine, then its last lines, with "… N righe omesse …" between', () => {
    // Three loads: the first two short and stopped, the last one ran every request.
    const blocks = [
      { label: 'cold-load 1', lines: [...range('c', 40), ...range('cr', 100)] },
      { label: 'warm-load 1', lines: range('w', 30) },
      { label: 'warm-load 2', lines: [...range('h', LOG_HEAD_LINES), omittedLine(500), ...range('t', 2000)] },
    ];
    const lines = buildLogExcerpt(blocks, ['note 1', 'note 2']).split('\n');
    // One line is left over: the short block needs no marker.
    expect(lines).toHaveLength(LOG_EXCERPT_LINES - 1);
    // Every engine's start is there.
    expect(lines.slice(0, 41)).toEqual(['=== cold-load 1 ===', ...range('c', 40)]);
    expect(lines).toContain('=== warm-load 1 ===');
    expect(lines).toContain('w29');
    const last = lines.indexOf('=== warm-load 2 ===');
    expect(lines.slice(last + 1, last + 1 + LOG_HEAD_LINES)).toEqual(range('h', LOG_HEAD_LINES));
    // The engine's own marker is merged with what the excerpt drops, once per block.
    const marker = lines[last + 1 + LOG_HEAD_LINES] as string;
    expect(omittedCount(marker)).toBeGreaterThan(500);
    expect(lines.filter((l) => omittedCount(l) !== undefined)).toHaveLength(2);
    // The latest lines of the latest engine, then the notes.
    expect(lines.slice(-5)).toEqual(['t1998', 't1999', '=== llm-bench ===', 'note 1', 'note 2']);
    // Lines between kept head and kept tail are accounted for exactly.
    const keptTail = lines.slice(last + 2 + LOG_HEAD_LINES, -3).length;
    expect(omittedCount(marker)).toBe(500 + 2000 - keptTail);
  });

  it('shrinks heads evenly when they alone would not fit, and keeps the byte cap', () => {
    const blocks = Array.from({ length: 6 }, (_, b) => ({ label: `load ${b}`, lines: range(`b${b}-`, 200) }));
    const lines = buildLogExcerpt(blocks, []).split('\n');
    expect(lines).toHaveLength(LOG_EXCERPT_LINES);
    for (let b = 0; b < 6; b++) expect(lines).toContain(`b${b}-0`);
    expect(lines.at(-1)).toBe('b5-199');

    const wide = buildLogExcerpt([{ label: 'a', lines: range('y'.repeat(1000), 300) }], ['note']);
    expect(Buffer.byteLength(wide)).toBeLessThanOrEqual(LOG_EXCERPT_BYTES);
    expect(wide.split('\n').some((l) => omittedCount(l) !== undefined)).toBe(true);
    expect(wide.endsWith('note')).toBe(true);
  });

  it('falls back to the last lines when even one line per block does not fit', () => {
    const blocks = Array.from({ length: 3 }, (_, b) => ({ label: `load ${b}`, lines: ['z'.repeat(LOG_EXCERPT_BYTES * 2)] }));
    const text = buildLogExcerpt(blocks, []);
    expect(text.length).toBe(LOG_EXCERPT_BYTES / 4);
  });
});
