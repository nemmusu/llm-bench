import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';

export type EmptyIllustration = 'results' | 'search' | 'downloads';

/** Small, calm line illustrations drawn with theme tokens (no external assets). */
function Illustration({ kind }: { kind: EmptyIllustration }) {
  return (
    <svg aria-hidden width="132" height="96" viewBox="0 0 132 96" fill="none">
      <rect x="10" y="14" width="112" height="72" rx="12" fill="var(--surface)" stroke="var(--border-strong)" />
      <rect x="10" y="14" width="112" height="16" rx="12" fill="var(--surface-2)" />
      <circle cx="22" cy="22" r="2.5" fill="var(--border-strong)" />
      <circle cx="30" cy="22" r="2.5" fill="var(--border-strong)" />
      {kind === 'results' && (
        <>
          <rect x="26" y="60" width="10" height="16" rx="2" fill="var(--accent-line)" />
          <rect x="42" y="50" width="10" height="26" rx="2" fill="var(--accent-line)" />
          <rect x="58" y="42" width="10" height="34" rx="2" fill="var(--accent)" />
          <rect x="74" y="54" width="10" height="22" rx="2" fill="var(--accent-line)" />
          <path d="M90 66 L100 52 L110 58" stroke="var(--accent-2)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
        </>
      )}
      {kind === 'search' && (
        <>
          <rect x="24" y="42" width="56" height="8" rx="4" fill="var(--surface-3)" />
          <rect x="24" y="56" width="40" height="8" rx="4" fill="var(--surface-3)" />
          <circle cx="92" cy="56" r="13" stroke="var(--accent)" strokeWidth="3" fill="var(--accent-soft)" />
          <path d="M101.5 65.5 L110 74" stroke="var(--accent)" strokeWidth="3.5" strokeLinecap="round" />
        </>
      )}
      {kind === 'downloads' && (
        <>
          <path d="M66 40 V64" stroke="var(--accent)" strokeWidth="3" strokeLinecap="round" />
          <path d="M56 55 L66 65 L76 55" stroke="var(--accent)" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
          <rect x="44" y="70" width="44" height="5" rx="2.5" fill="var(--surface-3)" />
          <rect x="44" y="70" width="18" height="5" rx="2.5" fill="var(--accent-2)" />
        </>
      )}
      <path d="M118 8 l2 5 l5 2 l-5 2 l-2 5 l-2 -5 l-5 -2 l5 -2 z" fill="var(--accent-2)" opacity="0.8" />
    </svg>
  );
}

export interface EmptyStateProps {
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  illustration?: EmptyIllustration;
  className?: string;
  /** Heading level for the title (keeps the page outline valid). */
  headingLevel?: 2 | 3;
}

/** Friendly empty screen with an illustration and one suggested action. */
export function EmptyState({ title, description, action, illustration = 'results', className, headingLevel = 2 }: EmptyStateProps) {
  const Heading = headingLevel === 2 ? 'h2' : 'h3';
  return (
    <div className={cn('flex flex-col items-center justify-center gap-3 px-6 py-12 text-center', className)}>
      <Illustration kind={illustration} />
      <Heading className="mt-2 text-lg font-semibold tracking-[-0.01em]">{title}</Heading>
      {description && <p className="max-w-md text-sm text-fg-2">{description}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}
