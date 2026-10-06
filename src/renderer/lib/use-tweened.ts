import { useEffect, useRef, useState } from 'react';
import { prefersReducedMotion } from './theme';

/**
 * Smoothly animates a displayed number towards `target` so live values glide instead of
 * jumping. Returns the target directly when the user prefers reduced motion.
 */
export function useTweened(target: number, durationMs = 450): number {
  const [shown, setShown] = useState(target);
  const fromRef = useRef(target);
  const shownRef = useRef(target);
  shownRef.current = shown;

  useEffect(() => {
    if (prefersReducedMotion() || durationMs <= 0) {
      setShown(target);
      return;
    }
    fromRef.current = shownRef.current;
    const start = performance.now();
    let frame = 0;
    const step = (now: number) => {
      const p = Math.min(1, (now - start) / durationMs);
      // easeOutCubic: fast start, gentle landing.
      const eased = 1 - (1 - p) ** 3;
      setShown(fromRef.current + (target - fromRef.current) * eased);
      if (p < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [target, durationMs]);

  return shown;
}
