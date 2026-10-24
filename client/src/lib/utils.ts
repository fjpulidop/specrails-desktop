import { type ClassValue, clsx } from 'clsx'
import { extendTailwindMerge } from 'tailwind-merge'

// Custom type-scale tokens (globals.css `--text-*`) are font sizes, not colours;
// without this, `text-caption` would swallow a sibling `text-accent-*` colour.
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      'font-size': [{ text: ['micro', 'caption', 'label', 'body', 'strong', 'title', 'headline', 'display', 'display-xl'] }],
    },
  },
})

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
