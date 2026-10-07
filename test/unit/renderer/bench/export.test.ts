import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RunResult } from '../../../../src/contract/results';
import { createFormatters } from '../../../../src/renderer/i18n';
import { bundleRequest, EXPORT_FORMATS, exportContent, exportFileName, exportRequest } from '../../../../src/renderer/lib/export';
import { csvCell, csvHeader, csvNumber, csvRows, runToCsv, toCsv } from '../../../../src/renderer/lib/export/csv';
import { escapeHtml, reportToHtml } from '../../../../src/renderer/lib/export/html';
import { fence, mdCell, mdText, reportToMarkdown } from '../../../../src/renderer/lib/export/markdown';
import { reportOf } from '../../../../src/renderer/lib/export/report';
import { saveTextFile } from '../../../../src/renderer/lib/export/save';
import { IDS, seeded } from './fixtures';

const it_ = createFormatters('it');
const en = createFormatters('en');

afterEach(() => {
  delete (window as { gpubench?: unknown }).gpubench;
  vi.restoreAllMocks();
});

describe('CSV', () => {
  it('formats numbers and cells for both dialects', () => {
    expect(csvNumber(1234.56789, 'excel-it')).toBe('1234,5679');
    expect(csvNumber(1234.56789, 'standard')).toBe('1234.5679');
    expect(csvNumber(-3, 'excel-it')).toBe('-3');
    expect(csvCell(undefined, 'standard')).toBe('');
    expect(csvCell(Number.NaN, 'standard')).toBe('');
    expect(csvCell('a;b', 'excel-it')).toBe('"a;b"');
    expect(csvCell('a;b', 'standard')).toBe('a;b');
    expect(csvCell('a,b', 'standard')).toBe('"a,b"');
    expect(csvCell('say "hi"', 'standard')).toBe('"say ""hi"""');
    expect(csvCell('two\nlines', 'excel-it')).toBe('"two\nlines"');
    // Formula injection is neutralized.
    expect(csvCell('=HYPERLINK("x")', 'standard')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvCell('+1', 'excel-it')).toBe("'+1");
    expect(csvCell('@sum', 'excel-it')).toBe("'@sum");
  });

  it('writes Excel-Italian with BOM, semicolons and decimal commas', () => {
    const text = toCsv(['a', 'b'], [[1.5, 'x']], 'excel-it');
    expect(text).toBe('\uFEFFa;b\r\n1,5;x\r\n');
    expect(toCsv(['a', 'b'], [[1.5, undefined]], 'standard')).toBe('a,b\r\n1.5,\r\n');
  });

  it('exports every measurement of a full run', () => {
    const run = seeded(IDS.full);
    const rows = csvRows(run, it_);
    expect(csvHeader(it_)).toEqual(['Sezione', 'Misura', 'Prompt (token)', 'Utenti', 'Valore', 'Min', 'Max', 'Dev. std', 'Variazione', 'Ripetizioni', 'Unità']);
    expect(rows.find((r) => r[1] === 'Generazione' && r[2] === 512)?.[4]).toBe(run.metrics.latency[1]!.decodeTps.median);
    expect(rows.some((r) => r[0] === 'Più utenti' && r[3] === 16)).toBe(true);
    expect(rows.some((r) => r[0] === 'llama-bench')).toBe(true);
    expect(rows.some((r) => r[1] === 'Punteggio GPU Bench')).toBe(true);
    expect(rows.some((r) => r[4] === 'gpu_shared')).toBe(true);
    const csv = runToCsv(run, it_, 'excel-it');
    expect(csv.startsWith('\uFEFFSezione;Misura;')).toBe(true);
    // Numbers for spreadsheets: never grouped like the screen ("8192", not "8.192").
    expect(csv).toContain(';8192;');
    expect(csv).not.toContain('8.192');
    expect(runToCsv(run, en, 'standard').startsWith('Section,Measurement,')).toBe(true);
  });

  it('exports sparse, failed and vLLM runs', () => {
    const failed = csvRows(seeded(IDS.failed), it_);
    expect(failed.some((r) => r[1] === 'Errore' && String(r[4]).startsWith('ENGINE_OOM'))).toBe(true);
    const vllm = csvRows(seeded(IDS.vllm), it_);
    expect(vllm.some((r) => r[1] === 'Avvio del contenitore')).toBe(true);
    expect(vllm.some((r) => r[4] === 'gpu_memory_reduced')).toBe(true);
    const bare: RunResult = {
      ...seeded(IDS.quick),
      hardware: { ...seeded(IDS.quick).hardware, gpus: [] },
      model: { ...seeded(IDS.quick).model, sha256: undefined },
      metrics: {
        formulaVersion: 1,
        load: { phases: [] },
        latency: [{ ...seeded(IDS.quick).metrics.latency[0]!, prefillTpsEngine: undefined, decodeTpsEngine: undefined }],
        contextSweep: [],
        sessions: [],
        concurrency: [],
        llamaBench: [],
        vram: {},
        energy: {},
        thermals: { throttleReasons: [] },
      },
    };
    const rows = csvRows(bare, en);
    expect(rows.filter((r) => r[0] === 'Speed by prompt length')).toHaveLength(6);
  });
});

describe('Markdown', () => {
  it('escapes text, cells and code fences', () => {
    expect(mdCell('a|b\nc\\d')).toBe('a\\|b c\\\\d');
    expect(mdText('*bold* _x_ [l](u) <b> #h `c`')).toBe('\\*bold\\* \\_x\\_ \\[l\\](u) \\<b\\> \\#h \\`c\\`');
    expect(fence('plain')).toBe('```');
    expect(fence('has ``` inside and ````')).toBe('`````');
  });

  it('renders the whole report', () => {
    const md = reportToMarkdown(reportOf(seeded(IDS.full), it_), { powershell: 'PowerShell', bash: 'bash' });
    expect(md.startsWith('# Qwen3 8B · Q4\\_K\\_M · llama.cpp b11438 (CUDA 13.4)')).toBe(true);
    expect(md).toContain('> Scrive circa');
    expect(md).toContain('| Prompt | Primo token (ms) |');
    expect(md).toContain('| ---: | ---: |');
    expect(md).toContain('```powershell');
    expect(md).toContain('- **Altri programmi stavano usando la GPU**');
    expect(md).toContain('_Creato con GPU Bench 0.1.0 · risultato 01K6Y7Q2ZC4M8N3B5V9R1T0XWE_');
  });
});

describe('HTML', () => {
  it('escapes everything and never contains scripts', () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe('&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;');
    const evil: RunResult = { ...seeded(IDS.failed), model: { ...seeded(IDS.failed).model, displayName: '<script>alert(1)</script>' } };
    const html = reportToHtml(reportOf(evil, en), { lang: 'en', labels: { powershell: 'PowerShell', bash: 'bash' } });
    expect(html).not.toContain('<script');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain("Content-Security-Policy");
    expect(html).toContain('Not enough graphics memory');
    expect(html).not.toContain('class="sentence"');
    const full = reportToHtml(reportOf(seeded(IDS.full), it_), { lang: 'it', labels: { powershell: 'PowerShell', bash: 'bash' } });
    expect(full).toContain('<html lang="it">');
    expect(full).toContain('class="sentence"');
    expect(full).toContain('<td class="num">');
  });
});

describe('report', () => {
  it('describes runs with missing data honestly', () => {
    const r = reportOf(seeded(IDS.failed), it_);
    expect(r.sections[0]!.title).toBe('Non riuscito');
    expect(r.sentence).toBeUndefined();
    const kpi = r.sections.find((s) => s.title === 'Numeri principali')!.table!;
    expect(kpi.rows.find((row) => row[0]?.startsWith('Generazione'))?.[1]).toBe('–');
    expect(kpi.rows.find((row) => row[0] === 'VRAM di picco')?.[1]).toBe('31,1 GB (approssimato)');
    const exact = reportOf(seeded(IDS.full), it_).sections.find((s) => s.title === 'Numeri principali')!.table!;
    expect(exact.rows.find((row) => row[0] === 'VRAM di picco')?.[1]).toBe('6,8 GB');
    const bare: RunResult = { ...seeded(IDS.quick), hardware: { ...seeded(IDS.quick).hardware, gpus: [] }, metrics: { ...seeded(IDS.quick).metrics, vram: {} }, validity: [], notes: [] };
    const b = reportOf(bare, en);
    expect(b.meta[0]).toBe('–');
    expect(b.sections.some((s) => s.title === 'Good to know about this result')).toBe(false);
    expect(b.sections.find((s) => s.title === 'System')!.table!.rows[0]![1]).toBe('–');
  });
});

describe('export formats and saving', () => {
  it('names files and builds every format', () => {
    const run = seeded(IDS.full);
    expect(exportFileName(run, 'csv')).toBe('gpubench_Qwen3-8B_2026-10-06_01K6Y7Q2.csv');
    for (const f of EXPORT_FORMATS) {
      const req = exportRequest(run, f, it_);
      expect(req.content.length).toBeGreaterThan(100);
      expect(req.filters[0]!.extensions[0]).toBe(req.defaultName.split('.').pop());
    }
    expect(JSON.parse(exportContent(run, 'json', it_))).toEqual(run);
    expect(bundleRequest({ format: 'gpubench-export', runs: [] }, new Date('2026-10-06T00:00:00Z')).defaultName).toBe('gpubench_2026-10-06.gpubench');
  });

  it('uses the native dialog in the desktop app', async () => {
    const saveFile = vi.fn(async () => 'C:\\out.csv');
    (window as { gpubench?: unknown }).gpubench = { saveFile };
    await expect(saveTextFile({ defaultName: 'a.csv', content: 'x', mime: 'text/csv', filters: [] })).resolves.toBe('C:\\out.csv');
    expect(saveFile).toHaveBeenCalledWith({ defaultName: 'a.csv', content: 'x', filters: [] });
  });

  it('falls back to a download link in browser mode', async () => {
    vi.useFakeTimers();
    const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:x');
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    await expect(saveTextFile({ defaultName: 'r.md', content: '# x', mime: 'text/markdown', filters: [] })).resolves.toBe('r.md');
    expect(create).toHaveBeenCalled();
    expect(click).toHaveBeenCalled();
    expect(document.querySelector('a[download]')).toBeNull();
    vi.advanceTimersByTime(2500);
    expect(revoke).toHaveBeenCalledWith('blob:x');
    vi.useRealTimers();
  });
});
