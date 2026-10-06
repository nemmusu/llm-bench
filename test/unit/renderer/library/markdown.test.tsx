import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseInline, parseMarkdown, safeUrl } from '../../../../src/renderer/lib/markdown/parse';
import { Markdown, openLink } from '../../../../src/renderer/lib/markdown/render';

afterEach(() => {
  delete (window as { gpubench?: unknown }).gpubench;
});

describe('safeUrl', () => {
  it('accepts https only', () => {
    expect(safeUrl('https://huggingface.co/x')).toBe('https://huggingface.co/x');
    expect(safeUrl('  HTTPS://Example.com/a  ')).toBe('https://example.com/a');
    for (const bad of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:text/html,<b>', 'http://example.com', 'mailto:a@b.c', 'vbscript:x', 'file:///c:/x', '//evil.com/x', '#anchor', '', '   ']) {
      expect(safeUrl(bad), bad).toBeUndefined();
    }
  });

  it('resolves relative paths against an https base only', () => {
    expect(safeUrl('figures/a.png', 'https://huggingface.co/o/n/resolve/main/')).toBe('https://huggingface.co/o/n/resolve/main/figures/a.png');
    expect(safeUrl('figures/a.png')).toBeUndefined();
    expect(safeUrl('a.png', 'http://insecure/')).toBeUndefined();
    expect(safeUrl('https://[bad')).toBeUndefined();
  });
});

describe('parseInline', () => {
  it('code, strong, emphasis, links, images, autolinks and breaks', () => {
    const nodes = parseInline('A `x` **b** __c__ *d* _e_ [l](https://a.b) ![i](https://a.b/i.png) <https://auto.link> f<br>g &amp; h\nnext');
    expect(nodes).toEqual([
      { type: 'text', text: 'A ' },
      { type: 'code', text: 'x' },
      { type: 'text', text: ' ' },
      { type: 'strong', children: [{ type: 'text', text: 'b' }] },
      { type: 'text', text: ' ' },
      { type: 'strong', children: [{ type: 'text', text: 'c' }] },
      { type: 'text', text: ' ' },
      { type: 'em', children: [{ type: 'text', text: 'd' }] },
      { type: 'text', text: ' ' },
      { type: 'em', children: [{ type: 'text', text: 'e' }] },
      { type: 'text', text: ' ' },
      { type: 'link', href: 'https://a.b/', children: [{ type: 'text', text: 'l' }] },
      { type: 'text', text: ' ' },
      { type: 'image', src: 'https://a.b/i.png', alt: 'i' },
      { type: 'text', text: ' ' },
      { type: 'link', href: 'https://auto.link/', children: [{ type: 'text', text: 'https://auto.link' }] },
      { type: 'text', text: ' f' },
      { type: 'br' },
      { type: 'text', text: 'g & h next' },
    ]);
  });

  it('drops unsafe links and images but keeps their text, strips HTML', () => {
    expect(parseInline('[click](javascript:alert)')).toEqual([{ type: 'text', text: 'click' }]);
    expect(parseInline('![logo](data:image/png;base64,AAAA)')).toEqual([{ type: 'text', text: 'logo' }]);
    expect(parseInline('<http://plain.example>')).toEqual([{ type: 'text', text: 'http://plain.example' }]);
    expect(parseInline('<img src=x onerror=alert(1)>hi<script>bad()</script>')).toEqual([{ type: 'text', text: 'hibad()' }]);
    expect(parseInline('![](javascript:x)')).toEqual([]);
    expect(parseInline('snake_case_word stays')).toEqual([{ type: 'text', text: 'snake_case_word stays' }]);
    expect(parseInline('**a**<span></span>**b**')).toEqual([
      { type: 'strong', children: [{ type: 'text', text: 'a' }] },
      { type: 'strong', children: [{ type: 'text', text: 'b' }] },
    ]);
  });

  it('nested image inside a link, relative link with base', () => {
    const nodes = parseInline('[![badge](https://img/b.svg)](docs/x.md)', { linkBase: 'https://hf.co/o/n/blob/main/' });
    expect(nodes).toEqual([{ type: 'link', href: 'https://hf.co/o/n/blob/main/docs/x.md', children: [{ type: 'image', src: 'https://img/b.svg', alt: 'badge' }] }]);
  });
});

describe('parseMarkdown', () => {
  it('blocks of a typical model card', () => {
    const md = [
      '---',
      'license: apache-2.0',
      '---',
      '<!-- hidden -->',
      '<div align="center">',
      '# Title #',
      '',
      'Para line one',
      'line two',
      '',
      '- a',
      '  - nested',
      'lazy continuation',
      '',
      '3. three',
      '4) four',
      '',
      '```python',
      'print("<b>")',
      '```',
      '',
      '> quoted **text**',
      '> # inner',
      '',
      '---',
      '',
      '| A | B \\| C |',
      '|---|:---:|',
      '| 1 | `2` |',
      '| 3 |',
      '',
      '<p align="center">Centered</p>',
      '~~~',
      'unterminated',
    ].join('\r\n');
    const blocks = parseMarkdown(md);
    expect(blocks.map((b) => b.type)).toEqual(['heading', 'paragraph', 'list', 'list', 'code', 'quote', 'hr', 'table', 'paragraph', 'code']);
    expect(blocks[0]).toEqual({ type: 'heading', level: 1, children: [{ type: 'text', text: 'Title' }] });
    expect(blocks[1]).toEqual({ type: 'paragraph', children: [{ type: 'text', text: 'Para line one line two' }] });
    expect(blocks[2]).toEqual({
      type: 'list',
      ordered: false,
      start: 1,
      items: [
        { depth: 0, children: [{ type: 'text', text: 'a' }] },
        { depth: 1, children: [{ type: 'text', text: 'nested' }, { type: 'text', text: ' ' }, { type: 'text', text: 'lazy continuation' }] },
      ],
    });
    expect(blocks[3]).toMatchObject({ type: 'list', ordered: true, start: 3 });
    expect(blocks[4]).toEqual({ type: 'code', lang: 'python', text: 'print("<b>")' });
    expect(blocks[5]).toMatchObject({ type: 'quote', children: [{ type: 'paragraph' }, { type: 'heading', level: 1 }] });
    expect(blocks[7]).toMatchObject({ type: 'table', header: [[{ text: 'A' }], [{ text: 'B | C' }]] });
    expect((blocks[7] as { rows: unknown[][] }).rows).toHaveLength(2);
    expect(blocks[8]).toEqual({ type: 'paragraph', children: [{ type: 'text', text: 'Centered' }] });
    expect(blocks[9]).toEqual({ type: 'code', lang: '', text: 'unterminated' });
  });

  it('a paragraph stops at the next block; empty paragraphs disappear', () => {
    expect(parseMarkdown('text\n# h').map((b) => b.type)).toEqual(['paragraph', 'heading']);
    expect(parseMarkdown('![](javascript:x)')).toEqual([]);
    expect(parseMarkdown('<br>\n')).toEqual([]);
  });
});

describe('<Markdown>', () => {
  it('renders elements only, never HTML, and opens https links through the bridge', () => {
    const openExternal = vi.fn(async () => undefined);
    (window as { gpubench?: unknown }).gpubench = { openExternal };
    const md = '# Card\n\n## Sub\n\n#### Deep\n\nSee [docs](https://hf.co/docs) <script>alert(1)</script><img src=x onerror=alert(1)>\n\n- one\n  - two\n\n1. first\n\n```\ncode\n```\n\n> quote\n\n---\n\n| h |\n|---|\n| c |\n\n![pic](img.png) `inline` *em* **bold**<br>after';
    const { container } = render(<Markdown text={md} linkBase="https://hf.co/o/n/blob/main/" imageBase="https://hf.co/o/n/resolve/main/" />);
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('img[onerror]')).toBeNull();
    expect(screen.getByRole('heading', { level: 3, name: 'Card' })).toBeTruthy();
    expect(screen.getByRole('heading', { level: 4, name: 'Sub' })).toBeTruthy();
    expect(screen.getByRole('heading', { level: 6, name: 'Deep' })).toBeTruthy();
    expect((screen.getByRole('img', { name: 'pic' }) as HTMLImageElement).src).toBe('https://hf.co/o/n/resolve/main/img.png');
    expect(screen.getByRole('table')).toBeTruthy();
    expect(container.querySelector('ol')?.getAttribute('start')).toBe('1');
    expect(container.querySelector('li[style]')).toBeTruthy();
    const link = screen.getByRole('link', { name: 'docs' });
    expect(link.getAttribute('rel')).toBe('noreferrer noopener');
    fireEvent.click(link);
    expect(openExternal).toHaveBeenCalledWith('https://hf.co/docs');
  });

  it('without the bridge links keep their default behaviour; heading offset is configurable', () => {
    render(<Markdown text={'# Top\n\n[a](https://x.y)'} headingOffset={0} className="extra" />);
    expect(screen.getByRole('heading', { level: 1, name: 'Top' })).toBeTruthy();
    const e = { preventDefault: vi.fn() } as unknown as Parameters<typeof openLink>[0];
    openLink(e, 'https://x.y');
    expect(e.preventDefault).not.toHaveBeenCalled();
  });
});
