import type { HTMLAttributes } from 'react'
import { cn } from '@/lib/utils'

interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  /** Text and background colours, e.g. `text-green bg-green-bg`. */
  tone?: string
}

export function Badge({ className, tone = 'text-foreground bg-muted', ...props }: BadgeProps) {
  return (
    <span
      className={cn('inline-flex h-5 items-center rounded-full px-2 text-[11px] font-medium', tone, className)}
      {...props}
    />
  )
}
