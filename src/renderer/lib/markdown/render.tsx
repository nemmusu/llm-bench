import { Fragment, useMemo, type MouseEvent, type ReactNode } from 'react';
import { cn } from '../cn';
import { parseMarkdown, type Block, type Inline, type ParseOptions } from './parse';

/** Opens https links in the system browser (Electron) instead of navigating the app window. */
export function openLink(e: MouseEvent<HTMLAnchorElement>, href: string): void {
  const bridge = window.gpubench;
  if (!bridge) return;
  e.preventDefault();
  void bridge.openExternal(href);
}

function renderInline(nodes: Inline[]): ReactNode[] {
  return nodes.map((n, i) => {
    switch (n.type) {
      case 'text':
        return <Fragment key={i}>{n.text}</Fragment>;
      case 'code':
        return (
          <code key={i} className="rounded-xs bg-surface-3 px-1 py-0.5 font-mono text-[0.9em] text-fg">
            {n.text}
          </code>
        );
      case 'strong':
        return (
          <strong key={i} className="font-semibold text-fg">
            {renderInline(n.children)}
          </strong>
        );
      case 'em':
        return <em key={i}>{renderInline(n.children)}</em>;
      case 'link':
        return (
          <a key={i} href={n.href} target="_blank" rel="noreferrer noopener" onClick={(e) => openLink(e, n.href)} className="text-accent-text underline underline-offset-2 hover:no-underline focus-ring rounded-xs">
            {renderInline(n.children)}
          </a>
        );
      case 'image':
        return <img key={i} src={n.src} alt={n.alt} loading="lazy" referrerPolicy="no-referrer" className="inline-block max-h-80 max-w-full rounded-md align-middle" />;
      default:
        return <br key={i} />;
    }
  });
}

const headingClass: Record<number, string> = {
  3: 'mt-6 text-lg font-semibold tracking-[-0.01em]',
  4: 'mt-5 text-md font-semibold',
  5: 'mt-4 text-sm font-semibold',
  6: 'mt-4 text-sm font-semibold text-fg-2',
};

function renderBlocks(blocks: Block[], headingOffset: number): ReactNode[] {
  return blocks.map((b, i) => {
    switch (b.type) {
      case 'heading': {
        const level = Math.min(6, b.level + headingOffset);
        const Tag = `h${level}` as 'h3';
        return (
          <Tag key={i} className={cn('first:mt-0', headingClass[Math.max(3, level)])}>
            {renderInline(b.children)}
          </Tag>
        );
      }
      case 'paragraph':
        return (
          <p key={i} className="mt-3 first:mt-0">
            {renderInline(b.children)}
          </p>
        );
      case 'list': {
        const items = b.items.map((it, j) => (
          <li key={j} style={it.depth > 0 ? { marginLeft: `${it.depth * 1.25}rem` } : undefined}>
            {renderInline(it.children)}
          </li>
        ));
        return b.ordered ? (
          <ol key={i} start={b.start} className="mt-3 list-decimal space-y-1 pl-6 first:mt-0">
            {items}
          </ol>
        ) : (
          <ul key={i} className="mt-3 list-disc space-y-1 pl-6 first:mt-0">
            {items}
          </ul>
        );
      }
      case 'code':
        return (
          <pre key={i} tabIndex={0} className="mt-3 overflow-x-auto rounded-lg border border-border bg-surface-2 p-3 font-mono text-xs leading-5 text-fg first:mt-0 focus-ring">
            <code data-lang={b.lang || undefined}>{b.text}</code>
          </pre>
        );
      case 'quote':
        return (
          <blockquote key={i} className="mt-3 border-l-2 border-accent-line pl-4 text-fg-2 first:mt-0">
            {renderBlocks(b.children, headingOffset)}
          </blockquote>
        );
      case 'table':
        return (
          <div key={i} className="mt-3 overflow-x-auto first:mt-0">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr>
                  {b.header.map((c, j) => (
                    <th key={j} scope="col" className="border-b border-border-strong px-2 py-1.5 text-left font-semibold">
                      {renderInline(c)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {b.rows.map((r, j) => (
                  <tr key={j}>
                    {r.map((c, k) => (
                      <td key={k} className="border-b border-border px-2 py-1.5 align-top">
                        {renderInline(c)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      default:
        return <hr key={i} className="my-5 border-border" />;
    }
  });
}

export interface MarkdownProps extends ParseOptions {
  text: string;
  /** Model-card headings start below the page's own (h1 page, h2 section → card h1 = h3). */
  headingOffset?: number;
  className?: string;
}

/** Renders untrusted Markdown as React elements only: no HTML, no scripts, https links only. */
export function Markdown({ text, headingOffset = 2, className, linkBase, imageBase }: MarkdownProps) {
  const blocks = useMemo(
    () => parseMarkdown(text, { ...(linkBase ? { linkBase } : {}), ...(imageBase ? { imageBase } : {}) }),
    [text, linkBase, imageBase],
  );
  return <div className={cn('text-sm leading-6 text-fg-2 [overflow-wrap:anywhere]', className)}>{renderBlocks(blocks, headingOffset)}</div>;
}
