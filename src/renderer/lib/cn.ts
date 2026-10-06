import { clsx, type ClassValue } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

/**
 * tailwind-merge must know our custom scales, otherwise it treats `text-2xs` (size) and
 * `text-fg-2` (color) as the same group and drops one of them.
 */
const twMerge = extendTailwindMerge({
  extend: {
    theme: {
      text: ['2xs', 'xs', 'sm', 'base', 'md', 'lg', 'xl', '2xl', '3xl', '4xl', '5xl', '6xl'],
      spacing: ['card', 'section', 'control', 'control-sm', 'row'],
      radius: ['xs', 'sm', 'md', 'lg', 'xl', '2xl', '3xl'],
      shadow: ['xs', 'sm', 'md', 'lg', 'glow'],
    },
  },
});

/** Joins class names and resolves Tailwind conflicts (last one wins). */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
