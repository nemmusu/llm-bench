import { Link } from '@tanstack/react-router';
import type { ReactNode } from 'react';

/** Shared pieces of the catalog's compact rows (Hugging Face models, suggestions, tried models). */

function Monogram({ name }: { name: string }) {
  return (
    <span aria-hidden className="grid size-5 shrink-0 place-items-center rounded-md bg-surface-2 text-[10px] font-semibold text-fg-2 uppercase ring-1 ring-border">
      {name.slice(0, 1)}
    </span>
  );
}

/** Compact row, as on huggingface.co/models: "owner/name" on top, the facts in one quiet line below. */
export const rowClass =
  'relative flex min-w-0 flex-col gap-1 rounded-lg border border-border bg-surface px-3.5 py-2.5 transition-colors hover:border-border-strong hover:bg-surface-2 has-[a:focus-visible]:border-accent';

/** "owner/name" as a link covering the whole row. */
export function RowTitle({ owner, name, extra }: { owner: string; name: string; extra?: ReactNode }) {
  return (
    <p className="flex min-w-0 items-center gap-2">
      <Monogram name={owner} />
      <Link
        to="/models/hub/$owner/$name"
        params={{ owner, name }}
        // The model page's "← Modelli" then goes back here (same list, same scroll) instead of a fresh catalog.
        state={(prev) => ({ ...prev, fromCatalog: true })}
        aria-label={`${owner}/${name}`}
        className="min-w-0 truncate rounded-xs font-mono text-[13px] text-fg after:absolute after:inset-0 after:rounded-lg focus-ring"
      >
        <span className="text-fg-2">{owner}/</span>
        <span className="font-semibold">{name}</span>
      </Link>
      {extra}
    </p>
  );
}

/** The facts line under a row title; items are separated by a middle dot. */
export function RowFacts({ children }: { children: ReactNode[] }) {
  const items = children.filter(Boolean);
  return (
    <div className="flex min-w-0 items-center gap-x-1.5 overflow-hidden text-xs whitespace-nowrap text-fg-3 tabular-nums">
      {items.map((c, i) => (
        <span key={i} className="inline-flex items-center gap-1.5">
          {i > 0 && <span aria-hidden>·</span>}
          {c}
        </span>
      ))}
    </div>
  );
}
