import React from 'react'
import { cn } from '../../lib/utils.js'

export function Card({ className, ...props }) {
  return <div className={cn('rounded-xl border border-line bg-background', className)} {...props} />
}

export function CardHeader({ className, ...props }) {
  return <div className={cn('flex items-center gap-2 px-4 py-2', className)} {...props} />
}

export function CardTitle({ className, ...props }) {
  return <h2 className={cn('text-[12px] font-medium text-foreground', className)} {...props} />
}

export function CardDescription({ className, ...props }) {
  return <p className={cn('text-[11px] text-subtle-foreground', className)} {...props} />
}

export function CardContent({ className, ...props }) {
  return <div className={cn('px-4', className)} {...props} />
}
