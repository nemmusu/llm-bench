/** Short numbers for presets and configurations: "32K" tokens, "07/10" dates, the banner sentence. */
import type { Formatters } from '../../i18n';
import type { PresetProvenance } from '../bench/run-context';

/** 512 → "512", 32768 → "32K", 4864 → "4,8K" (K = 1024 tokens, as contexts are counted). */
export function tokensShort(n: number, f: Pick<Formatters, 'integer' | 'number'>): string {
  if (n < 1024) return f.integer(n);
  return n % 1024 === 0 ? `${f.integer(n / 1024)}K` : `${f.number(n / 1024, 1)}K`;
}

/** Day and month: "07/10" (it), "10/07" (en). */
export function shortDate(iso: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, { day: '2-digit', month: '2-digit' }).format(new Date(iso));
}

/** "Preset da «Qwen3 8B · Q4_K_M» del 07/10: 82 tok/s a 32K, 64K di contesto". */
export function provenanceText(p: PresetProvenance, f: Pick<Formatters, 't' | 'integer' | 'number' | 'locale'>): string {
  const { t } = f;
  const label = p.combo === undefined ? p.label : `${p.label} · ${t('presets.combo', { n: p.combo + 1 })}`;
  const title = t('presets.banner.title', { label, date: shortDate(p.date, f.locale) });
  const facts: string[] = [];
  if (p.decodeTps !== undefined && p.depth !== undefined) facts.push(t('presets.banner.speed', { tps: f.integer(p.decodeTps), depth: tokensShort(p.depth, f) }));
  if (p.contextSize !== undefined) facts.push(t('presets.banner.context', { ctx: tokensShort(p.contextSize, f) }));
  return facts.length ? `${title}: ${facts.join(', ')}` : title;
}
