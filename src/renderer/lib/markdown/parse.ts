/**
 * A deliberately small Markdown parser for Hugging Face model cards. It produces a plain data
 * tree (never HTML): raw HTML tags are dropped (their text is kept), and the renderer turns the
 * tree into React elements, so nothing from a model card can inject markup or script.
 *
 * Supported: ATX headings, paragraphs, bullet / numbered lists (with nesting depth), fenced code,
 * block quotes, tables, horizontal rules; inline code, **strong**, *emphasis*, [links](…),
 * ![images](…), <https://autolinks> and hard line breaks (<br>).
 */

export type Inline =
  | { type: 'text'; text: string }
  | { type: 'code'; text: string }
  | { type: 'strong'; children: Inline[] }
  | { type: 'em'; children: Inline[] }
  | { type: 'link'; href: string; children: Inline[] }
  | { type: 'image'; src: string; alt: string }
  | { type: 'br' };

export interface ListItem {
  depth: number;
  children: Inline[];
}

export type Block =
  | { type: 'heading'; level: number; children: Inline[] }
  | { type: 'paragraph'; children: Inline[] }
  | { type: 'list'; ordered: boolean; start: number; items: ListItem[] }
  | { type: 'code'; lang: string; text: string }
  | { type: 'quote'; children: Block[] }
  | { type: 'table'; header: Inline[][]; rows: Inline[][][] }
  | { type: 'hr' };

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([\w+#.-]*)/;
const HEADING = /^ {0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/;
const HR = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
const QUOTE = /^ {0,3}>\s?/;
const LIST = /^(\s*)([-*+]|(\d{1,9})[.)])\s+(.*)$/;
const TABLE_RULE = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
const HTML_LINE = /^ {0,3}<\/?[a-zA-Z][^>]*>/;

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };

function decodeEntities(s: string): string {
  return s.replace(/&(amp|lt|gt|quot|apos|nbsp|#39);/g, (_m, name: string) => ENTITIES[name] as string);
}

/** Drops HTML tags but keeps their text; <br> becomes a line break. */
function stripHtml(s: string): string {
  return s.replace(/<br\s*\/?>/gi, '\n').replace(/<\/?[a-zA-Z][^>]*>/g, '');
}

/**
 * A link or image target we are willing to show: https only. Relative paths are resolved against
 * `base` (the repo page), which must itself be https. Anything else (javascript:, data:, http:,
 * mailto:, protocol-relative) is refused.
 */
export function safeUrl(raw: string, base?: string): string | undefined {
  const url = raw.trim();
  if (!url || url.startsWith('//') || url.startsWith('#')) return undefined;
  const absolute = /^[a-z][a-z0-9+.-]*:/i.test(url);
  if (!absolute && !base) return undefined;
  try {
    const u = absolute ? new URL(url) : new URL(url, base);
    return u.protocol === 'https:' ? u.href : undefined;
  } catch {
    return undefined;
  }
}

export interface ParseOptions {
  /** Base for relative links (e.g. https://huggingface.co/owner/name/blob/main/). */
  linkBase?: string;
  /** Base for relative images (e.g. https://huggingface.co/owner/name/resolve/main/). */
  imageBase?: string;
}

const INLINE =
  /(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)|!\[([^\]]*)\]\(\s*<?([^\s)>]*)>?(?:\s+"[^"]*")?\s*\)|\[((?:[^[\]]|\[[^\]]*\])*)\]\(\s*<?([^\s)>]*)>?(?:\s+"[^"]*")?\s*\)|<(https?:\/\/[^>\s]+)>|\*\*([\s\S]+?)\*\*|__([\s\S]+?)__|\*([^*\s](?:[^*]*[^*\s])?)\*|(?<![\w])_([^_\s](?:[^_]*[^_\s])?)_(?![\w])|\n/g;

/** Inline Markdown of one paragraph, heading, list item or table cell. */
export function parseInline(src: string, opts: ParseOptions = {}): Inline[] {
  const out: Inline[] = [];
  const pushText = (s: string) => {
    if (!s) return;
    const text = decodeEntities(stripHtml(s));
    const last = out[out.length - 1];
    if (last?.type === 'text') last.text += text;
    else if (text) out.push({ type: 'text', text });
  };
  // Autolinks look like tags: protect them before tags are stripped from text runs.
  let pos = 0;
  for (const m of src.matchAll(INLINE)) {
    pushText(src.slice(pos, m.index));
    pos = m.index + m[0].length;
    const [, , code, alt, imgSrc, linkText, href, autolink, strong1, strong2, em1, em2] = m;
    if (code !== undefined) out.push({ type: 'code', text: code.trim() });
    else if (imgSrc !== undefined) {
      const safe = safeUrl(imgSrc, opts.imageBase);
      if (safe) out.push({ type: 'image', src: safe, alt: alt as string });
      else pushText(alt as string);
    } else if (linkText !== undefined) {
      const children = parseInline(linkText, opts);
      const safe = safeUrl(href as string, opts.linkBase);
      if (safe) out.push({ type: 'link', href: safe, children });
      else out.push(...children);
    } else if (autolink !== undefined) {
      const safe = safeUrl(autolink);
      if (safe) out.push({ type: 'link', href: safe, children: [{ type: 'text', text: autolink }] });
      else pushText(autolink);
    } else if (strong1 !== undefined || strong2 !== undefined) out.push({ type: 'strong', children: parseInline((strong1 ?? strong2) as string, opts) });
    else if (em1 !== undefined || em2 !== undefined) out.push({ type: 'em', children: parseInline((em1 ?? em2) as string, opts) });
    else {
      // Only a newline is left: a soft break inside a paragraph is a space; text runs merge across it.
      pushText(' ');
    }
  }
  pushText(src.slice(pos));
  return splitBreaks(out);
}

/** Text runs that came from <br> carry "\n": turn those into explicit breaks. */
function splitBreaks(nodes: Inline[]): Inline[] {
  const out: Inline[] = [];
  for (const n of nodes) {
    if (n.type !== 'text' || !n.text.includes('\n')) {
      out.push(n);
      continue;
    }
    n.text.split('\n').forEach((part, i) => {
      if (i > 0) out.push({ type: 'br' });
      if (part) out.push({ type: 'text', text: part });
    });
  }
  return out;
}

function cells(row: string): string[] {
  const trimmed = row.trim().replace(/^\|/, '').replace(/\|$/, '');
  return trimmed.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
}

function startsBlock(line: string, next: string | undefined): boolean {
  return FENCE.test(line) || HEADING.test(line) || HR.test(line) || QUOTE.test(line) || LIST.test(line) || isTableStart(line, next);
}

function isTableStart(line: string, next: string | undefined): boolean {
  return line.includes('|') && next !== undefined && next.includes('-') && TABLE_RULE.test(next);
}

/** Block-level parse of a whole document. */
export function parseMarkdown(text: string, opts: ParseOptions = {}): Block[] {
  let src = text.replace(/\r\n?/g, '\n').replace(/<!--[\s\S]*?-->/g, '');
  // YAML front matter (every HF model card has one): metadata, not content.
  src = src.replace(/^---\n[\s\S]*?\n---(?:\n|$)/, '');
  return parseBlocks(src.split('\n'), opts);
}

function parseBlocks(lines: string[], opts: ParseOptions): Block[] {
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] as string;
    if (line.trim() === '') {
      i++;
      continue;
    }
    const fence = FENCE.exec(line);
    if (fence) {
      const marker = fence[1] as string;
      const body: string[] = [];
      i++;
      while (i < lines.length && !(lines[i] as string).trimStart().startsWith(marker)) body.push(lines[i++] as string);
      i++;
      blocks.push({ type: 'code', lang: fence[2] as string, text: body.join('\n') });
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      blocks.push({ type: 'heading', level: (heading[1] as string).length, children: parseInline(heading[2] as string, opts) });
      i++;
      continue;
    }
    if (HR.test(line)) {
      blocks.push({ type: 'hr' });
      i++;
      continue;
    }
    if (QUOTE.test(line)) {
      const body: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i] as string)) body.push((lines[i++] as string).replace(QUOTE, ''));
      blocks.push({ type: 'quote', children: parseBlocks(body, opts) });
      continue;
    }
    const list = LIST.exec(line);
    if (list) {
      const ordered = list[3] !== undefined;
      const items: ListItem[] = [];
      const baseIndent = (list[1] as string).length;
      while (i < lines.length) {
        const cur = lines[i] as string;
        const m = LIST.exec(cur);
        if (m) {
          items.push({ depth: Math.max(0, Math.floor(((m[1] as string).length - baseIndent) / 2)), children: parseInline(m[4] as string, opts) });
          i++;
          continue;
        }
        // Lazy continuation of the previous item (indented or plain text, not a new block).
        if (cur.trim() !== '' && !startsBlock(cur, lines[i + 1])) {
          (items[items.length - 1] as ListItem).children.push({ type: 'text', text: ' ' }, ...parseInline(cur.trim(), opts));
          i++;
          continue;
        }
        break;
      }
      blocks.push({ type: 'list', ordered, start: ordered ? Number(list[3]) : 1, items });
      continue;
    }
    if (isTableStart(line, lines[i + 1])) {
      const header = cells(line).map((c) => parseInline(c, opts));
      const rows: Inline[][][] = [];
      i += 2;
      while (i < lines.length && (lines[i] as string).includes('|') && (lines[i] as string).trim() !== '') {
        rows.push(cells(lines[i++] as string).map((c) => parseInline(c, opts)));
      }
      blocks.push({ type: 'table', header, rows });
      continue;
    }
    if (HTML_LINE.test(line) && stripHtml(line).trim() === '') {
      // Layout-only HTML (<div align="center">, <p>, <img …>): nothing to show.
      i++;
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && (lines[i] as string).trim() !== '' && (para.length === 0 || !startsBlock(lines[i] as string, lines[i + 1]))) {
      para.push(lines[i++] as string);
    }
    const children = parseInline(para.join('\n'), opts);
    if (children.length > 0) blocks.push({ type: 'paragraph', children });
  }
  return blocks;
}
