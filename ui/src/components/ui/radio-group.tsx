import * as RadioGroupPrimitive from '@radix-ui/react-radio-group'
import type { ComponentProps, ReactNode } from 'react'
import { cn } from '@/lib/utils'

export function RadioGroup({ className, ...props }: ComponentProps<typeof RadioGroupPrimitive.Root>) {
  return <RadioGroupPrimitive.Root className={cn('grid gap-2.5', className)} {...props} />
}

export function RadioItem({
  className,
  children,
  ...props
}: ComponentProps<typeof RadioGroupPrimitive.Item> & { children: ReactNode }) {
  return (
    <label className="inline-flex cursor-pointer items-center gap-2 text-[13px]">
      <RadioGroupPrimitive.Item
        className={cn(
          'size-4 shrink-0 rounded-full border border-ring bg-background outline-none focus-visible:ring-2 focus-visible:ring-ring data-[state=checked]:border-primary',
          className,
        )}
        {...props}
      >
        <RadioGroupPrimitive.Indicator className="relative flex size-full items-center justify-center after:size-2 after:rounded-full after:bg-primary" />
      </RadioGroupPrimitive.Item>
      {children}
    </label>
  )
}

/** One option of a segmented control: a radio that looks like a tab (the checked one is raised). */
export function SegmentItem({
  className,
  children,
  ...props
}: ComponentProps<typeof RadioGroupPrimitive.Item> & { children: ReactNode }) {
  return (
    <RadioGroupPrimitive.Item
      className={cn(
        'inline-flex h-7 min-w-0 flex-1 items-center justify-center gap-1.5 rounded-[5px] px-2.5 text-[13px] font-medium text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring data-[state=checked]:bg-background data-[state=checked]:text-foreground data-[state=checked]:shadow-sm',
        className,
      )}
      {...props}
    >
      {children}
    </RadioGroupPrimitive.Item>
  )
}
