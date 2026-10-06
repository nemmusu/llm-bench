import { createContext, useContext, useMemo, type ReactNode } from 'react';
import type { ErrorCode } from '../../contract/errors';
import type { RunPhase } from '../../contract/events';
import type { ValidityFlag } from '../../contract/results';
import { en } from './en';
import { it, type Messages } from './it';

export type Lang = 'it' | 'en';

type Leaves<T, P extends string = ''> = {
  [K in keyof T & string]: T[K] extends string ? `${P}${K}` : Leaves<T[K], `${P}${K}.`>;
}[keyof T & string];

/** Every valid translation key, e.g. "nav.results". */
export type MessageKey = Leaves<Messages>;
export type Params = Record<string, string | number>;

const DICTS: Record<Lang, Messages> = { it, en };

export function lookup(dict: Messages, key: string): string {
  let node: unknown = dict;
  for (const part of key.split('.')) {
    if (node && typeof node === 'object' && part in node) node = (node as Record<string, unknown>)[part];
    else return key;
  }
  return typeof node === 'string' ? node : key;
}

export function interpolate(text: string, params?: Params): string {
  if (!params) return text;
  return text.replace(/\{(\w+)\}/g, (m, name: string) => (name in params ? String(params[name]) : m));
}

export function translate(lang: Lang, key: MessageKey, params?: Params): string {
  return interpolate(lookup(DICTS[lang], key), params);
}

export interface Formatters {
  lang: Lang;
  locale: string;
  t: (key: MessageKey, params?: Params) => string;
  number: (n: number, digits?: number) => string;
  integer: (n: number) => string;
  percent: (ratio: number, digits?: number) => string;
  /** Bytes with binary units shown as GB/MB like Windows Explorer. */
  bytes: (n: number) => string;
  /** Milliseconds as a short duration: "850 ms", "4,2 s", "2 min 05 s". */
  duration: (ms: number) => string;
  date: (iso: string | number) => string;
  dateTime: (iso: string | number) => string;
  relative: (iso: string | number, now?: number) => string;
}

export function createFormatters(lang: Lang): Formatters {
  const locale = lang === 'it' ? 'it-IT' : 'en-US';
  const nf = (digits: number) =>
    new Intl.NumberFormat(locale, { minimumFractionDigits: digits, maximumFractionDigits: digits });
  const number = (n: number, digits = 1) => nf(digits).format(n);
  const integer = (n: number) => nf(0).format(Math.round(n));
  const bytes = (n: number) => {
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let v = n;
    let u = 0;
    while (Math.abs(v) >= 1024 && u < units.length - 1) {
      v /= 1024;
      u++;
    }
    return `${number(v, u === 0 ? 0 : v >= 100 ? 0 : 1)} ${units[u]}`;
  };
  const duration = (ms: number) => {
    if (ms < 1000) return `${integer(ms)} ms`;
    const s = ms / 1000;
    if (s < 60) return `${number(s, s < 10 ? 2 : 1)} s`;
    const m = Math.floor(s / 60);
    const rest = Math.round(s - m * 60);
    return `${m} min ${String(rest).padStart(2, '0')} s`;
  };
  const dateFmt = new Intl.DateTimeFormat(locale, { dateStyle: 'medium' });
  const dateTimeFmt = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' });
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  const relative = (iso: string | number, now = Date.now()) => {
    const diff = (new Date(iso).getTime() - now) / 1000;
    const abs = Math.abs(diff);
    if (abs < 60) return rtf.format(Math.round(diff), 'second');
    if (abs < 3600) return rtf.format(Math.round(diff / 60), 'minute');
    if (abs < 86400) return rtf.format(Math.round(diff / 3600), 'hour');
    if (abs < 86400 * 30) return rtf.format(Math.round(diff / 86400), 'day');
    return dateFmt.format(new Date(iso));
  };
  return {
    lang,
    locale,
    t: (key, params) => translate(lang, key, params),
    number,
    integer,
    percent: (r, d = 0) => new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: d }).format(r),
    bytes,
    duration,
    date: (iso) => dateFmt.format(new Date(iso)),
    dateTime: (iso) => dateTimeFmt.format(new Date(iso)),
    relative,
  };
}

const I18nContext = createContext<Formatters>(createFormatters('it'));

export function I18nProvider({ lang, children }: { lang: Lang; children: ReactNode }) {
  const value = useMemo(() => createFormatters(lang), [lang]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): Formatters {
  return useContext(I18nContext);
}

// Compile-time guarantees that the catalogs cover every code/flag from the contract, and nothing else.
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Assert<T extends true> = T;
export type ErrorCatalogIsExhaustive = Assert<Exact<keyof Messages['errors'], ErrorCode>>;
export type ValidityCatalogIsExhaustive = Assert<Exact<keyof Messages['validity'], ValidityFlag>>;
export type PhaseCatalogIsExhaustive = Assert<Exact<Exclude<keyof Messages['phases'], 'state'>, RunPhase>>;

/** Localized "what happened / what to do" for an error code from the core. */
export function errorText(f: Pick<Formatters, 't'>, code: ErrorCode): { title: string; what: string } {
  return { title: f.t(`errors.${code}.title`), what: f.t(`errors.${code}.what`) };
}
