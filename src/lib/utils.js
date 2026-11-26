import { clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'

/** shadcn's class combiner: conditional classes, later wins on conflicts. */
export function cn(...inputs) {
  return twMerge(clsx(inputs))
}
