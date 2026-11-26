import React from 'react'
import { cn } from '../../lib/utils.js'

export function Table({ className, ...props }) {
  return <table className={cn('w-full border-collapse caption-bottom text-[12px]', className)} {...props} />
}

export function TableHeader({ className, ...props }) {
  return <thead className={cn('border-b border-line', className)} {...props} />
}

export function TableBody({ className, ...props }) {
  return <tbody className={className} {...props} />
}

export function TableRow({ className, ...props }) {
  return <tr className={cn('border-b border-line/60 transition-colors last:border-0 hover:bg-surface/70', className)} {...props} />
}

export function TableHead({ className, ...props }) {
  return (
    <th
      className={cn('h-[30px] whitespace-nowrap px-2 text-left align-middle text-[11px] font-medium text-subtle-foreground', className)}
      {...props}
    />
  )
}

export function TableCell({ className, ...props }) {
  return <td className={cn('h-[26px] px-2 align-middle', className)} {...props} />
}
