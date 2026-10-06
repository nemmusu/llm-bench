import { useId } from 'react';
import { cn } from '../../lib/cn';

/** GPU Bench mark: a gauge needle on the brand gradient. Same drawing as resources/icons/icon.svg. */
export function Logo({ size = 24, className }: { size?: number; className?: string }) {
  const id = useId();
  return (
    <svg aria-hidden width={size} height={size} viewBox="0 0 32 32" className={cn('shrink-0', className)}>
      <defs>
        <linearGradient id={`${id}-bg`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#8576ff" />
          <stop offset="1" stopColor="#4b3bd6" />
        </linearGradient>
        <linearGradient id={`${id}-needle`} x1="0" y1="1" x2="1" y2="0">
          <stop offset="0" stopColor="#ffffff" />
          <stop offset="1" stopColor="#7ff3ff" />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="8.5" fill={`url(#${id}-bg)`} />
      <rect x="0.5" y="0.5" width="31" height="31" rx="8" fill="none" stroke="#ffffff" strokeOpacity="0.18" />
      <path d="M8.2 21.4a8 8 0 1 1 15.6 0" fill="none" stroke="#ffffff" strokeOpacity="0.38" strokeWidth="2.6" strokeLinecap="round" />
      <path d="M8.2 21.4a8 8 0 0 1 11.6-9.9" fill="none" stroke="#ffffff" strokeWidth="2.6" strokeLinecap="round" />
      <path d="M16 20.2 L21.4 12.6" stroke={`url(#${id}-needle)`} strokeWidth="2.4" strokeLinecap="round" />
      <circle cx="16" cy="20.4" r="2.3" fill="#ffffff" />
    </svg>
  );
}
