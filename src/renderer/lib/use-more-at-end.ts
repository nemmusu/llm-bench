import { useLayoutEffect, useState, type RefObject } from 'react';

/**
 * Whether a sideways-scrolling box hides content past its right edge: the cue for a fade there, so a
 * table cut by a narrow window says there is more to see.
 */
export function useMoreAtEnd(ref: RefObject<HTMLElement | null>): boolean {
  const [more, setMore] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current!;
    const update = () => setMore(el.scrollWidth - el.clientWidth - el.scrollLeft > 1);
    update();
    el.addEventListener('scroll', update, { passive: true });
    // The window, the rows (filters, sorting) and the fonts change the widths.
    const ro = new ResizeObserver(update);
    ro.observe(el);
    for (const child of el.children) ro.observe(child);
    return () => {
      el.removeEventListener('scroll', update);
      ro.disconnect();
    };
  }, [ref]);
  return more;
}
