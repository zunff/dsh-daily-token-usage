import React from 'react'
import { cva } from 'class-variance-authority'
import { cn } from '../../lib/utils.js'

const badgeVariants = cva(
  'inline-flex items-center gap-1 whitespace-nowrap rounded-full px-1.5 py-0.5 text-[10px] font-medium leading-none',
  {
    variants: {
      variant: {
        secondary: 'bg-surface text-muted-foreground',
        success: 'bg-success/12 text-success',
        danger: 'bg-danger/12 text-danger',
        outline: 'border border-line text-muted-foreground',
      },
    },
    defaultVariants: { variant: 'secondary' },
  },
)

export function Badge({ className, variant, ...props }) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />
}
