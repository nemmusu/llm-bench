/**
 * Standalone HTML report: one file, inline CSS, no scripts (a Content-Security-Policy forbids
 * them too), every piece of text escaped. Opens in any browser and prints well.
 */
import type { Report, ReportTable } from './report';

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ESCAPES[c]!);
}

const CSS = `
:root{color-scheme:light dark;--bg:#f4f5f8;--card:#fff;--fg:#1b1f2a;--fg2:#4a5160;--fg3:#7a8090;--border:#e2e4ea;--accent:#7c3aed;--warn:#fff7e6;--warnb:#f5c46b;--code:#f0f1f5}
@media (prefers-color-scheme:dark){:root{--bg:#0b0d12;--card:#141720;--fg:#e6e8ee;--fg2:#b4b9c6;--fg3:#868c9a;--border:#262a36;--accent:#a78bfa;--warn:#2a2210;--warnb:#7a5a12;--code:#1b1f2a}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.55 Inter,"Segoe UI",system-ui,sans-serif}
main{max-width:960px;margin:0 auto;padding:40px 24px 64px}
h1{font-size:26px;letter-spacing:-.02em;margin:0 0 6px}.meta{color:var(--fg2);margin:0 0 20px}
.sentence{border-left:3px solid var(--accent);padding:10px 16px;background:var(--card);border-radius:8px;font-size:16px;font-weight:500}
section{background:var(--card);border:1px solid var(--border);border-radius:14px;padding:18px 20px;margin:18px 0}
h2{font-size:16px;margin:0 0 12px}table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}
th,td{padding:7px 10px;border-bottom:1px solid var(--border);text-align:left}th{color:var(--fg3);font-weight:500;font-size:12px}
.num{text-align:right}.callout{background:var(--warn);border:1px solid var(--warnb);border-radius:10px;padding:10px 14px;margin:8px 0}
.callout b{display:block}pre{background:var(--code);border-radius:10px;padding:12px 14px;white-space:pre-wrap;word-break:break-all;font:12px/1.6 "JetBrains Mono",Consolas,monospace}
.label{color:var(--fg3);font-size:12px;margin:12px 0 4px}footer{color:var(--fg3);font-size:12px;text-align:center}
@media print{body{background:#fff}section{break-inside:avoid}}
`;

function table(t: ReportTable): string {
  const cls = (i: number) => (i >= t.numericFrom ? ' class="num"' : '');
  const head = t.head.map((h, i) => `<th scope="col"${cls(i)}>${escapeHtml(h)}</th>`).join('');
  const rows = t.rows.map((r) => `<tr>${r.map((c, i) => `<td${cls(i)}>${escapeHtml(c)}</td>`).join('')}</tr>`).join('');
  return `<table><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table>`;
}

export function reportToHtml(report: Report, opts: { lang: string; labels: { powershell: string; bash: string } }): string {
  const sections = report.sections
    .map((s) => {
      const parts = [`<h2>${escapeHtml(s.title)}</h2>`];
      if (s.text) parts.push(`<p>${escapeHtml(s.text)}</p>`);
      for (const c of s.callouts ?? []) parts.push(`<div class="callout"><b>${escapeHtml(c.title)}</b>${escapeHtml(c.body)}</div>`);
      if (s.table) parts.push(table(s.table));
      if (s.code) {
        for (const shell of ['powershell', 'bash'] as const) {
          parts.push(`<p class="label">${escapeHtml(opts.labels[shell])}</p><pre><code>${escapeHtml(s.code[shell])}</code></pre>`);
        }
      }
      return `<section>${parts.join('')}</section>`;
    })
    .join('\n');
  return `<!doctype html>
<html lang="${escapeHtml(opts.lang)}">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(report.title)}</title>
<style>${CSS}</style>
</head>
<body>
<main>
<h1>${escapeHtml(report.title)}</h1>
<p class="meta">${escapeHtml(report.meta.join(' · '))}</p>
${report.sentence ? `<p class="sentence">${escapeHtml(report.sentence)}</p>` : ''}
${sections}
<footer>${escapeHtml(report.footer)}</footer>
</main>
</body>
</html>
`;
}
