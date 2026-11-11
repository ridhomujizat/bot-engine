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
