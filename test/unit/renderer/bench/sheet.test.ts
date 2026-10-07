import { describe, expect, it } from 'vitest';
import type { RunResult } from '../../../../src/contract/results';
import { summarize } from '../../../../src/core/bench/stats';
import { createFormatters } from '../../../../src/renderer/i18n';
import { reportToHtml } from '../../../../src/renderer/lib/export/html';
import { reportToMarkdown } from '../../../../src/renderer/lib/export/markdown';
import { modelInWords, redactSecrets, sheetOf, sheetRequest, type SheetInput } from '../../../../src/renderer/lib/export/sheet';
import { IDS, seeded } from './fixtures';
import { NOW_POINTS, sessionsPoint, teamRuns, withSessions } from './sessions-fixtures';

const it_ = createFormatters('it');
const en = createFormatters('en');
const NOW = new Date('2026-10-07T12:00:00.000Z');
const input = (over: Partial<SheetInput> = {}): SheetInput => ({ run: teamRuns().now, appVersion: '0.3.0', now: NOW, ...over });
const titles = (r: ReturnType<typeof sheetOf>) => r.sections.map((s) => s.title);

/** A run whose command, environment and notes are full of secrets that must never leave. */
function leaky(): RunResult {
  const run = structuredClone(teamRuns().now);
  run.launch.display = {
    powershell: '& vllm serve Qwen/Qwen3-30B --api-key sk-live-1234567890abcdef --hf-token hf_ABCDEFGHIJKLMNOPQRSTUV',
    bash: 'HF_TOKEN=hf_ABCDEFGHIJKLMNOPQRSTUV vllm serve Qwen/Qwen3-30B --api-key=secretkey123',
  };
  run.launch.params = { ...run.launch.params, extraArgs: ['--api-key', 'topsecret-value'] };
  return run;
}

describe('Scheda da condividere: content', () => {
  it('every section of the team page, in order, well written, numbers with units', () => {
    const r = sheetOf(input({ before: teamRuns().before, service: 'Assistente del team', address: 'http://gpu:8000/v1', notes: 'Riavvio ogni lunedì.\n\nScrivere a Marta.' }), it_);
    expect(r.title).toMatch(/^Assistente del team: /);
    expect(titles(r)).toEqual([
      'Il servizio',
      'Modello e configurazione',
      'Velocità e tempi di attesa',
      'Il contesto si legge una volta sola',
      'Come funziona la coda',
      'Contesto tenuto in memoria',
      'Confronto con la configurazione precedente',
      'Glossario',
    ]);
    const [service, setup, speed, cache, queue, memory, compare, glossary] = r.sections;
    expect(service?.table?.rows).toEqual([
      ['Nome del servizio', 'Assistente del team'],
      ['Indirizzo', 'http://gpu:8000/v1'],
    ]);
    expect(service?.paragraphs).toEqual(['Riavvio ogni lunedì.', 'Scrivere a Marta.']);
    expect(setup?.table?.rows.map((x) => x[0])).toEqual(['Modello', 'Motore', 'Scheda video', 'PC', 'Configurazione', 'Contesto']);
    expect(setup?.code?.bash).toBe(teamRuns().now.launch.display.bash);
    expect(speed?.paragraphs?.[0]).toBe('Con 1 sessione il primo messaggio aspetta 1 min 53 s per leggere 200.000 token; dal secondo il server riusa il 99,7% del contesto e l’attesa scende a 1,00 s.');
    expect(speed?.table?.head[2]).toBe('Attesa prima risposta a 200.000 token');
    expect(cache?.text).toBe('Dal secondo messaggio in poi il server riusa quello che ha già letto (99,7% con 1 sessione, 97,5% con 2 sessioni) e legge solo il testo nuovo: con 1 sessione l’attesa passa da 1 min 53 s a 1,00 s.');
    expect(queue?.paragraphs).toEqual(['Con 2 sessioni insieme ogni messaggio viene letto a 1783 token/s (con una sessione sola: 1763 token/s); quello che aspetta di più resta in coda 1 min 48 s (stima) prima che la sua lettura cominci.']);
    expect(memory?.text).toBe('La memoria del motore (KV cache) tiene 889.820 token (bastano per 4 conversazioni da 200.000).');
    expect(compare?.text).toMatch(/^Stesso modello, stesso PC\. Prima: vLLM .*\. Ora: vLLM /);
    expect(compare?.table?.head).toEqual(['Misura', 'Prima', 'Ora', 'Differenza']);
    const row = (label: RegExp) => compare?.table?.rows.find((x) => label.test(x[0] as string));
    expect(row(/^Lettura del contesto/)?.[3]).toBe('2,2 volte più veloce');
    expect(row(/^Velocità di scrittura/)?.[3]).toBe('+16%');
    expect(row(/^Contesto tenuto in memoria/)?.slice(1)).toEqual(['399.806 token', '889.820 token', '2,2 volte di più']);
    expect(row(/^Attesa prima risposta a/)?.slice(1)).toEqual(['4 min 07 s', '1 min 53 s', '2,2 volte più breve']);
    expect(row(/^Attesa risposte successive/)?.slice(1)).toEqual(['riletto da capo (4 min 06 s)', '1,00 s', 'prima riletto da capo, ora 1,00 s']);
    expect(glossary?.definitions?.map((d) => d.term)).toEqual(['Lettura del contesto', 'Attesa prima risposta', 'Attesa in coda', 'Contesto riusato', 'Velocità di scrittura']);
    expect(glossary?.paragraphs?.[0]).toMatch(/È un’approssimazione\.$/);
    expect(r.sentence).toBe('Qwen3-8B-FP8 con vLLM v0.12.0 (CUDA) su RTX 5090: legge il contesto a 1763 token/s e scrive a 31,7 token/s per conversazione (prova con 200.000 token).');
    expect(r.footer).toMatch(/^Scheda creata il .* con GPU Bench 0\.3\.0\./);
    expect(r.meta.at(-1)).toMatch(/^misurato il /);
  });

  it('without long conversations: the basic speeds; without a service: the plain title; English', () => {
    const r = sheetOf(input({ run: seeded(IDS.full) }), en);
    expect(r.title).toMatch(/^Server sheet: /);
    expect(titles(r)).toEqual(['Model and configuration', 'Speed and waiting times']);
    expect(r.sections[1]?.table?.head).toEqual(['Prompt (tokens)', 'Reading (tokens/s)', 'First answer wait', 'Writing (tokens/s)']);
    expect(r.sentence).toMatch(/reads text at \d[\d,]* tokens\/s and writes at [\d.]+ tokens\/s\.$/);
    // Nothing measured at all: no speed section, no sentence.
    const bare = structuredClone(seeded(IDS.failed));
    bare.metrics = { ...bare.metrics, latency: [] };
    const b = sheetOf(input({ run: bare }), it_);
    expect(titles(b)).toEqual(['Modello e configurazione']);
    expect(b.sentence).toBeUndefined();
  });

  it('cache unknown, no level 1, no queue: the sentences still hold', () => {
    const noShare = sessionsPoint({ sessions: 1, laterTurns: { ttftMs: summarize([900]), decodeTps: summarize([30]) } });
    const run = withSessions(seeded(IDS.vllm), 'x', [noShare], undefined, '2026-10-07T08:00:00.000Z');
    const r = sheetOf(input({ run }), it_);
    expect(r.sections.find((s) => s.title === 'Il contesto si legge una volta sola')?.text).toBe(
      'Il motore non dice quanta parte del contesto riusa dal secondo messaggio; con 1 sessione l’attesa passa da 1 min 53 s a 900 ms.',
    );
    expect(titles(r)).not.toContain('Come funziona la coda');
    const two = withSessions(seeded(IDS.vllm), 'y', [NOW_POINTS[1]!], undefined, '2026-10-07T08:00:00.000Z');
    const q = sheetOf(input({ run: two }), it_);
    expect(q.sections.find((s) => s.title === 'Come funziona la coda')?.paragraphs?.[0]).toBe(
      'Con 2 sessioni insieme ogni messaggio viene letto a 1783 token/s; quello che aspetta di più resta in coda 1 min 48 s (stima) prima che la sua lettura cominci.',
    );
    expect(titles(q)).not.toContain('Il contesto si legge una volta sola');
    const engine = withSessions(seeded(IDS.vllm), 'z', NOW_POINTS.map((p) => ({ ...p, queueEstimated: false })), undefined, '2026-10-07T08:00:00.000Z');
    expect(sheetOf(input({ run: engine }), it_).sections.find((s) => s.title === 'Come funziona la coda')?.paragraphs?.[0]).not.toContain('(stima)');
  });

  it('a comparison between different PCs or models says so plainly', () => {
    const other = structuredClone(teamRuns().before);
    other.hardware = { ...other.hardware, hostId: 'elsewhere' };
    const r = sheetOf(input({ before: other }), it_);
    expect(r.sections.find((s) => s.title === 'Confronto con la configurazione precedente')?.text).toMatch(/^Prima: /);
  });

  it('odd machines and launches: no GPU, no driver, a Docker image, default settings, one side without KV capacity', () => {
    const run = structuredClone(teamRuns().now);
    run.hardware = { ...run.hardware, gpus: [] };
    run.engine = { ...run.engine, image: 'vllm/vllm-openai:v0.12.0' };
    run.launch.params = { extraArgs: [], env: {} };
    const r = sheetOf({ run, appVersion: '0.3.0', now: NOW, address: 'http://gpu:8000/v1' }, it_);
    const rows = Object.fromEntries(r.sections[1]!.table!.rows.map((x) => [x[0], x[1]]));
    expect(r.sections[0]?.table?.rows).toEqual([['Indirizzo', 'http://gpu:8000/v1']]);
    expect(rows['Scheda video']).toBe('–');
    expect(rows['Motore']?.endsWith(' · vllm/vllm-openai:v0.12.0')).toBe(true);
    expect(rows['Configurazione']).toBe('impostazioni predefinite');
    expect(rows['Contesto']).toBeUndefined();
    expect(r.meta[1]).toBe('–');
    expect(r.sentence).toContain(' su –:');
    const basic = structuredClone(seeded(IDS.full));
    basic.hardware = { ...basic.hardware, gpus: [] };
    expect(sheetOf({ run: basic, appVersion: '0.3.0', now: NOW, service: 'Solo nome' }, it_).sentence).toContain(' su –:');
    const noDriver = structuredClone(seeded(IDS.full));
    noDriver.hardware = { ...noDriver.hardware, gpus: noDriver.hardware.gpus.map((g) => ({ ...g, driverVersion: undefined })) as RunResult['hardware']['gpus'] };
    expect(sheetOf({ run: noDriver, appVersion: '0.3.0', now: NOW }, it_).sections[0]!.table!.rows[2]![1]).not.toContain('driver');
    const noKv = structuredClone(teamRuns().before);
    delete noKv.metrics.kvCapacity;
    const cmp = sheetOf({ run: teamRuns().now, before: noKv, appVersion: '0.3.0', now: NOW }, it_).sections.find((x) => x.title === 'Confronto con la configurazione precedente');
    expect(cmp?.table?.rows.find((x) => x[0] === 'Contesto tenuto in memoria')?.slice(1)).toEqual(['–', '889.820 token', '–']);
  });

  it('the model in words', () => {
    const run = structuredClone(seeded(IDS.moe));
    run.model = { ...run.model, quant: 'Q4_K_M', facts: { paramsB: 30.5, expertCount: 128, expertUsedCount: 8, contextLength: 262144 } };
    expect(modelInWords(run, it_)).toBe('31 miliardi di parametri · Q4_K_M · 8 esperti attivi su 128 · contesto fino a 262.144 token');
    run.model = { ...run.model, quant: undefined, facts: { paramsB: 4 } } as RunResult['model'];
    expect(modelInWords(run, en)).toBe('4.0 billion parameters');
    run.model = { ...run.model, facts: undefined } as RunResult['model'];
    expect(modelInWords(run, en)).toBe('');
  });
});

describe('Scheda da condividere: never a secret', () => {
  it('scrubs tokens, keys, bearer headers, URL passwords and key parameters', () => {
    expect(redactSecrets('hf_ABCDEFGHIJKLMNOP and sk-proj_ABCDEFGH123')).toBe('<HF_TOKEN> and <API_KEY>');
    expect(redactSecrets('--api-key hunter2 --api-key=abc --api-key <API_KEY>')).toBe('--api-key <API_KEY> --api-key=<API_KEY> --api-key <API_KEY>');
    expect(redactSecrets('Authorization: Bearer abc.def')).toBe('Authorization: Bearer <API_KEY>');
    expect(redactSecrets('https://me:pw@host/v1?token=abc&x=1#k')).toBe('https://host/v1?token=<REDACTED>&x=1#k');
    expect(redactSecrets('nothing to hide: 1763 token/s')).toBe('nothing to hide: 1763 token/s');
  });

  it('Markdown and HTML of a leaky run and leaky fields carry none of it', () => {
    const run = leaky();
    for (const format of ['markdown', 'html'] as const) {
      const req = sheetRequest(
        { run, before: teamRuns().before, service: 'Team', address: 'http://u:pw@gpu:8000/v1?api_key=abc123', notes: 'Bearer zzz-token-zzz', appVersion: '0.3.0', now: NOW },
        format,
        it_,
      );
      for (const secret of ['sk-live-1234567890abcdef', 'hf_ABCDEFGHIJKLMNOPQRSTUV', 'secretkey123', 'topsecret-value', 'pw@', 'abc123', 'zzz-token-zzz']) {
        expect(req.content).not.toContain(secret);
      }
      expect(req.content).toContain('<API_KEY>'.replace(/</g, format === 'html' ? '&lt;' : '<').replace(/>/g, format === 'html' ? '&gt;' : '>'));
    }
  });

  it('files: names, types, and the page itself', () => {
    const md = sheetRequest(input({ service: 'Assistente del team' }), 'markdown', it_);
    expect(md.defaultName).toBe('gpubench_scheda_Assistente-del-team_2026-10-07.md');
    expect(md.mime).toBe('text/markdown;charset=utf-8');
    expect(md.content).toContain('# Assistente del team: ');
    expect(md.content).toContain('## Velocità e tempi di attesa');
    expect(md.content).toContain('| Sessioni insieme | Lettura del contesto (token/s) | Attesa prima risposta a 200.000 token |');
    expect(md.content).toContain('- **Contesto riusato**: ');
    expect(md.content).toContain('```bash');
    const html = sheetRequest(input(), 'html', en);
    expect(html.defaultName).toMatch(/^gpubench_sheet_.*\.html$/);
    expect(html.content).toContain('<html lang="en">');
    expect(html.content).toContain('<dt>Context reused</dt>');
    expect(html.content).toContain('<h2>The context is read only once</h2>');
    expect(html.content).not.toContain('<script');
  });

  it('report renderers: paragraphs and definitions', () => {
    const report = { title: 'T', meta: [], sections: [{ title: 'S', paragraphs: ['one | two', 'three'], definitions: [{ term: 'a_b', text: 'c' }] }], footer: 'F' };
    const md = reportToMarkdown(report, { powershell: 'PS', bash: 'sh' });
    expect(md).toContain('one \\| two\n\nthree\n\n- **a\\_b**: c');
    expect(reportToHtml(report, { lang: 'it', labels: { powershell: 'PS', bash: 'sh' } })).toContain('<p>one | two</p><p>three</p><dl><dt>a_b</dt><dd>c</dd></dl>');
  });
});
