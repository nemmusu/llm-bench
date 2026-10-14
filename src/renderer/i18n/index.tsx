import { createContext, useContext, useMemo, type ReactNode } from 'react';
import type { ErrorCode } from '../../contract/errors';
import type { RunPhase } from '../../contract/events';
import type { ValidityFlag } from '../../contract/results';
import { en } from './en';
import { it, type Messages } from './it';

export type Lang = 'it' | 'en';

/** The languages offered, English (the default) first. */
export const LANGUAGES: readonly Lang[] = ['en', 'it'];

/** Each language named in its own language: someone who cannot read the current one still finds theirs. */
export const LANGUAGE_NAMES: Record<Lang, string> = { en: 'English', it: 'Italiano' };

type Leaves<T, P extends string = ''> = {
  [K in keyof T & string]: T[K] extends string ? `${P}${K}` : Leaves<T[K], `${P}${K}.`>;
}[keyof T & string];

/** Every valid translation key, e.g. "nav.results". */
export type MessageKey = Leaves<Messages>;
export type Params = Record<string, string | number | boolean>;

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
  /** Short counts like Hugging Face: "7,3K", "1,5 Mln" (en: "7.3K", "1.5M"). */
  compact: (n: number) => string;
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
  // 'always': Italian CLDR leaves 4-digit numbers ungrouped ("1763" next to "12.865"); group them all.
  const nf = (digits: number) =>
    new Intl.NumberFormat(locale, { minimumFractionDigits: digits, maximumFractionDigits: digits, useGrouping: 'always' });
  const number = (n: number, digits = 1) => nf(digits).format(n);
  const integer = (n: number) => nf(0).format(Math.round(n));
  const compactNf = new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: 1 });
  const compact = (n: number) => compactNf.format(n);
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
    // Rounded first, so 119,6 s reads "2 min 00 s" (not "1 min 60 s").
    const total = Math.round(s);
    const m = Math.floor(total / 60);
    const rest = total - m * 60;
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
    compact,
    percent: (r, d = 0) => new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: d }).format(r),
    bytes,
    duration,
    date: (iso) => dateFmt.format(new Date(iso)),
    dateTime: (iso) => dateTimeFmt.format(new Date(iso)),
    relative,
  };
}

const I18nContext = createContext<Formatters>(createFormatters('en'));

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

/**
 * The "what to do" of an error with a reason of its own (errors.<code>.why.<reason>): a model the engine
 * cannot read (its format with a variant that reads it, its architecture, its container version), a
 * KV type the build does not have, a command before the server of a program with an OpenAI API that failed or got stuck.
 */
function whyKey(code: ErrorCode, params?: Params): MessageKey | undefined {
  const reason = params?.reason;
  if (code === 'ENGINE_NOT_INSTALLED' && reason === 'ninfer_all_missing') return 'errors.ENGINE_NOT_INSTALLED.why.ninferAll';
  if (code === 'ENGINE_MODEL_UNSUPPORTED') {
    // A layout only NInfer-all reads: NInfer's own second build, not a variant to add.
    if (params?.template === 'ninfer-all') return 'errors.ENGINE_MODEL_UNSUPPORTED.why.ninferAll';
    if (params?.variant !== undefined && (reason === 'layout' || reason === 'format')) return 'errors.ENGINE_MODEL_UNSUPPORTED.why.variant';
    if (reason === 'architecture' || reason === 'container') return `errors.ENGINE_MODEL_UNSUPPORTED.why.${reason}`;
  }
  // A command before the server of a program with an OpenAI API: which one, and how it ended.
  if (code === 'ENGINE_START_FAILED' && reason === 'step_failed') return 'errors.ENGINE_START_FAILED.why.step';
  if (code === 'ENGINE_TIMEOUT' && reason === 'step_timeout') return 'errors.ENGINE_TIMEOUT.why.step';
  if (code === 'ENGINE_BAD_FLAG' && reason === 'proposal_head_missing') return 'errors.ENGINE_BAD_FLAG.why.proposalHead';
  return code === 'ENGINE_BAD_FLAG' && reason === 'kv_dtype_unsupported' ? 'errors.ENGINE_BAD_FLAG.why.kvDtype' : undefined;
}

/** Localized "what happened / what to do" for an error code from the core, with its params (library, package…). */
export function errorText(f: Pick<Formatters, 't'>, code: ErrorCode, params?: Params): { title: string; what: string } {
  return { title: f.t(`errors.${code}.title`, params), what: f.t(whyKey(code, params) ?? `errors.${code}.what`, params) };
}
