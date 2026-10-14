import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ERROR_CODES } from '../../../src/contract/errors';
import { RUN_PHASES } from '../../../src/contract/events';
import { VALIDITY_FLAGS } from '../../../src/contract/results';
import { createFormatters, errorText, I18nProvider, interpolate, lookup, translate, useI18n } from '../../../src/renderer/i18n';
import { en } from '../../../src/renderer/i18n/en';
import { it as itDict } from '../../../src/renderer/i18n/it';
import './helpers';

/** All leaf paths of a nested dictionary, e.g. "nav.results". */
function leafKeys(node: unknown, prefix = ''): string[] {
  if (typeof node === 'string') return [prefix];
  return Object.entries(node as Record<string, unknown>).flatMap(([k, v]) => leafKeys(v, prefix ? `${prefix}.${k}` : k));
}

describe('dictionaries', () => {
  it('en has exactly the same keys as it', () => {
    expect(leafKeys(en).sort()).toEqual(leafKeys(itDict).sort());
  });

  it('no translation is empty and placeholders match between languages', () => {
    const itKeys = leafKeys(itDict);
    for (const key of itKeys) {
      const a = lookup(itDict, key);
      const b = lookup(en, key);
      expect(a.trim(), key).not.toBe('');
      expect(b.trim(), key).not.toBe('');
      const ph = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
      expect(ph(b), key).toEqual(ph(a));
    }
  });

  it('covers every error code, validity flag and run phase', () => {
    for (const code of ERROR_CODES) {
      for (const lang of ['it', 'en'] as const) {
        expect(translate(lang, `errors.${code}.title`)).not.toContain('errors.');
        expect(translate(lang, `errors.${code}.what`)).not.toContain('errors.');
      }
    }
    for (const flag of VALIDITY_FLAGS) expect(translate('it', `validity.${flag}.title`)).not.toContain('validity.');
    for (const p of RUN_PHASES) expect(translate('en', `phases.${p}.label`)).not.toContain('phases.');
  });

  it('errorText returns title and what-to-do', () => {
    const f = createFormatters('it');
    expect(errorText(f, 'DOCKER_NOT_RUNNING')).toEqual({ title: 'Docker non è avviato', what: 'Premi «Avvia Docker» e aspetta che sia pronto.' });
  });

  it('a command before the server of a program that failed or got stuck says which one', () => {
    const f = createFormatters('it');
    expect(errorText(f, 'ENGINE_START_FAILED', { reason: 'step_failed', which: 'before', n: 2, program: 'python.exe', code: '3' }).what).toBe(
      'Il comando 2 prima del server (python.exe) è finito con un errore (codice 3), quindi non ho avviato il server. Apri il log per vedere cosa ha scritto, correggilo nella pagina Motori e riprova.',
    );
    expect(errorText(createFormatters('en'), 'ENGINE_TIMEOUT', { reason: 'step_timeout', n: 1, program: 'fetch' }).what).toMatch(/^Command 1 before the server \(fetch\) did not end in time/);
    expect(errorText(f, 'ENGINE_TIMEOUT').what).toMatch(/^Riprova/);
  });
});

describe('lookup / interpolate / translate', () => {
  it('finds nested strings and falls back to the key', () => {
    expect(lookup(itDict, 'nav.results')).toBe('Risultati');
    expect(lookup(itDict, 'nav.missing')).toBe('nav.missing');
    expect(lookup(itDict, 'nav')).toBe('nav');
  });

  it('interpolates known params and keeps unknown placeholders', () => {
    expect(interpolate('a {x} b {y}', { x: 1 })).toBe('a 1 b {y}');
    expect(interpolate('plain')).toBe('plain');
  });

  it('translates in both languages', () => {
    expect(translate('it', 'app.version', { version: '1.2.3' })).toBe('Versione 1.2.3');
    expect(translate('en', 'app.version', { version: '1.2.3' })).toBe('Version 1.2.3');
  });
});

describe('formatters', () => {
  const itF = createFormatters('it');
  const enF = createFormatters('en');

  it('formats numbers with the locale', () => {
    // 4 digits are grouped too, in Italian as well: "1.763" next to "12.865", never "1763".
    expect(itF.number(1234.56)).toBe('1.234,6');
    expect(itF.number(12345.6, 1)).toBe('12.345,6');
    expect(enF.number(12345.6, 1)).toBe('12,345.6');
    expect(itF.integer(1763)).toBe('1.763');
    expect(enF.integer(1763)).toBe('1,763');
    expect(itF.integer(190.6)).toBe('191');
    expect(itF.percent(0.123, 1)).toBe('12,3%');
    expect(enF.percent(0.5)).toBe('50%');
  });

  it('formats bytes with binary units', () => {
    expect(itF.bytes(512)).toBe('512 B');
    expect(itF.bytes(480 * 1024 * 1024)).toBe('480 MB');
    expect(enF.bytes(4.68 * 1024 ** 3)).toBe('4.7 GB');
    expect(enF.bytes(5 * 1024 ** 5)).toBe('5,120 TB');
  });

  it('formats durations', () => {
    expect(itF.duration(57)).toBe('57 ms');
    expect(itF.duration(2104)).toBe('2,10 s');
    expect(enF.duration(21400)).toBe('21.4 s');
    expect(itF.duration(125000)).toBe('2 min 05 s');
  });

  it('formats dates and relative times', () => {
    const now = Date.parse('2026-10-06T12:00:00Z');
    expect(enF.relative(now - 20_000, now)).toBe('20 seconds ago');
    expect(enF.relative(now - 5 * 60_000, now)).toBe('5 minutes ago');
    expect(enF.relative(now - 3 * 3600_000, now)).toBe('3 hours ago');
    expect(itF.relative(now - 86400_000, now)).toBe('ieri');
    expect(enF.relative('2026-01-01T10:00:00Z', now)).toBe(enF.date('2026-01-01T10:00:00Z'));
    expect(itF.date('2026-10-06T10:42:00Z')).toMatch(/6 ott 2026/);
    expect(enF.dateTime('2026-10-06T10:42:00Z')).toMatch(/Oct 6, 2026/);
  });
});

describe('I18nProvider', () => {
  function Probe() {
    const { t, lang } = useI18n();
    return (
      <p>
        {lang}:{t('nav.settings')}
      </p>
    );
  }

  it('provides the selected language', () => {
    render(
      <I18nProvider lang="en">
        <Probe />
      </I18nProvider>,
    );
    expect(screen.getByText('en:Settings')).toBeTruthy();
  });

  it('defaults to English without a provider', () => {
    render(<Probe />);
    expect(screen.getByText('en:Settings')).toBeTruthy();
  });
});
