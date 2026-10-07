/** Markdown export: the report model as GitHub-flavoured Markdown (tables, fenced commands). */
import type { Report, ReportTable } from './report';

/** Table cell text: pipes escaped, line breaks flattened. */
export function mdCell(text: string): string {
  return text.replaceAll('\\', '\\\\').replaceAll('|', '\\|').replace(/\r?\n/g, ' ');
}

/** Plain paragraph text: Markdown control characters escaped so names never turn into markup. */
export function mdText(text: string): string {
  return text.replace(/([\\`*_[\]#<>|])/g, '\\$1').replace(/\r?\n/g, ' ');
}

/** A fence longer than any backtick run inside the code, so the code can never close it. */
export function fence(code: string): string {
  const longest = Math.max(0, ...(code.match(/`+/g) ?? []).map((r) => r.length));
  return '`'.repeat(Math.max(3, longest + 1));
}

function table(t: ReportTable): string[] {
  const align = t.head.map((_, i) => (i >= t.numericFrom ? '---:' : '---'));
  return [`| ${t.head.map(mdCell).join(' | ')} |`, `| ${align.join(' | ')} |`, ...t.rows.map((r) => `| ${r.map(mdCell).join(' | ')} |`)];
}

export function reportToMarkdown(report: Report, labels: { powershell: string; bash: string }): string {
  const out: string[] = [`# ${mdText(report.title)}`, '', report.meta.map(mdText).join(' · '), ''];
  if (report.sentence) out.push(`> ${mdText(report.sentence)}`, '');
  for (const s of report.sections) {
    out.push(`## ${mdText(s.title)}`, '');
    if (s.text) out.push(mdText(s.text), '');
    for (const para of s.paragraphs ?? []) out.push(mdText(para), '');
    if (s.definitions) out.push(...s.definitions.map((d) => `- **${mdText(d.term)}**: ${mdText(d.text)}`), '');
    if (s.callouts) for (const c of s.callouts) out.push(`- **${mdText(c.title)}**: ${mdText(c.body)}`);
    if (s.callouts) out.push('');
    if (s.table) out.push(...table(s.table), '');
    for (const para of s.after ?? []) out.push(mdText(para), '');
    if (s.code) {
      for (const [shell, lang] of [
        ['powershell', 'powershell'],
        ['bash', 'bash'],
      ] as const) {
        const code = s.code[shell];
        const f = fence(code);
        out.push(`**${mdText(labels[shell])}**`, '', `${f}${lang}`, code, f, '');
      }
    }
  }
  out.push('---', '', `_${mdText(report.footer)}_`, '');
  return out.join('\n');
}
