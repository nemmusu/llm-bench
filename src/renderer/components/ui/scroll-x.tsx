import { useRef, type ComponentProps } from 'react';
import { cn } from '../../lib/cn';
import { useMoreAtEnd } from '../../lib/use-more-at-end';

/**
 * A box that scrolls sideways (a wide table on a narrow window). While content hides past its right
 * edge, a fade there says there is more; at the end it goes away. Sits on a `surface` card.
 */
export function ScrollX({ className, children, ...props }: ComponentProps<'div'>) {
  const ref = useRef<HTMLDivElement>(null);
  const more = useMoreAtEnd(ref);
  return (
    <div className="relative">
      <div ref={ref} className={cn('overflow-x-auto', className)} {...props}>
        {children}
      </div>
      <div
        aria-hidden
        data-more={more ? 'end' : undefined}
        className={cn('pointer-events-none absolute inset-y-0 right-0 w-12 bg-linear-to-l from-surface to-transparent transition-opacity', more ? 'opacity-100' : 'opacity-0')}
      />
    </div>
  );
}
