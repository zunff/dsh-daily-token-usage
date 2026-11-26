import React from 'react'
import { cva } from 'class-variance-authority'
import { cn } from '../../lib/utils.js'

/**
 * The bundle carries no Tailwind preflight, so the base rule clears the browser's
 * default button chrome itself: without `border border-transparent bg-transparent`
 * a ghost or primary button keeps a UA outline and `buttonface` fill.
 */
const buttonVariants = cva(
  'inline-flex select-none items-center justify-center gap-1.5 whitespace-nowrap rounded-md border border-transparent bg-transparent font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-brand/40 disabled:pointer-events-none disabled:opacity-45',
  {
    variants: {
      variant: {
        // A disabled primary keeps its shape but drops the accent: at 45% opacity
        // the brand blue reads as a pale, broken button instead of an unavailable one.
        primary: 'bg-brand text-white hover:opacity-90 disabled:bg-surface disabled:text-subtle-foreground',
        outline: 'border-line-strong text-foreground hover:bg-surface',
        ghost: 'text-muted-foreground hover:bg-surface hover:text-foreground',
        subtle: 'bg-surface text-foreground hover:bg-surface/70',
        danger: 'text-danger hover:bg-danger/10',
      },
      size: {
        sm: 'h-7 px-2.5 text-[11.5px]',
        md: 'h-8 px-3.5 text-[12px]',
        icon: 'h-7 w-7 text-[13px]',
      },
    },
    defaultVariants: { variant: 'outline', size: 'sm' },
  },
)

export function Button({ className, variant, size, ...props }) {
  return <button type="button" className={cn(buttonVariants({ variant, size }), className)} {...props} />
}
