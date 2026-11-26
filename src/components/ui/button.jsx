import React from 'react'
import { cva } from 'class-variance-authority'
import { cn } from '../../lib/utils.js'

const buttonVariants = cva(
  'inline-flex select-none items-center justify-center gap-1 whitespace-nowrap rounded-md text-[11px] font-medium transition-colors disabled:pointer-events-none disabled:opacity-55',
  {
    variants: {
      variant: {
        outline: 'border border-line text-muted-foreground hover:bg-surface hover:text-foreground',
        ghost: 'text-muted-foreground hover:bg-surface hover:text-foreground',
        subtle: 'bg-surface text-muted-foreground hover:text-foreground',
      },
      size: {
        sm: 'h-6 px-2',
        icon: 'h-6 w-6',
      },
    },
    defaultVariants: { variant: 'outline', size: 'sm' },
  },
)

export function Button({ className, variant, size, ...props }) {
  return <button type="button" className={cn(buttonVariants({ variant, size }), className)} {...props} />
}
