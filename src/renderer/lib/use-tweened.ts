import { useEffect, useRef, useState } from 'react';
import { prefersReducedMotion } from './theme';

/**
 * Smoothly animates a displayed number towards `target` so live values glide instead of
 * jumping. Returns the target directly when the user prefers reduced motion.
 */
export function useTweened(target: number, durationMs = 450): number {
  const still = prefersReducedMotion() || durationMs <= 0;
  const [shown, setShown] = useState(target);
  // Last value painted: the next animation starts from there.
  const shownRef = useRef(target);

  useEffect(() => {
    if (still) return;
    const from = shownRef.current;
    const start = performance.now();
    let frame = 0;
    const step = (now: number) => {
      const p = Math.min(1, (now - start) / durationMs);
      // easeOutCubic: fast start, gentle landing.
      const value = from + (target - from) * (1 - (1 - p) ** 3);
      shownRef.current = value;
      setShown(value);
      if (p < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [target, durationMs, still]);

  return still ? target : shown;
}
