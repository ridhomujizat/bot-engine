import * as PopoverPrimitive from '@radix-ui/react-popover'
import type { ComponentProps } from 'react'
import { cn } from '@/lib/utils'

export const Popover = PopoverPrimitive.Root
export const PopoverTrigger = PopoverPrimitive.Trigger
export const PopoverAnchor = PopoverPrimitive.Anchor

/**
 * Floating panel of a trigger. Its width is the trigger's width, and it stays inside the viewport
 * and the dialog around it (collision padding), flipping or shifting when there is no room.
 */
export function PopoverContent({
  className,
  align = 'start',
  sideOffset = 4,
  collisionPadding = 12,
  ...props
}: ComponentProps<typeof PopoverPrimitive.Content>) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        align={align}
        sideOffset={sideOffset}
        collisionPadding={collisionPadding}
        className={cn(
          'z-[60] w-[--radix-popover-trigger-width] max-w-[min(var(--radix-popover-trigger-width),calc(100vw-24px))] overflow-hidden rounded-md border border-border bg-background text-[13px] shadow-md outline-none',
          className,
        )}
        {...props}
      />
    </PopoverPrimitive.Portal>
  )
}
