import * as SwitchPrimitive from '@radix-ui/react-switch'
import { cn } from '@/lib/utils'
import type { ComponentProps } from 'react'

export function Switch({ className, ...props }: ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      className={cn(
        'peer inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full bg-border p-0.5 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring data-[state=checked]:bg-primary',
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb className="block size-4 rounded-full bg-background shadow-sm transition-transform data-[state=checked]:translate-x-4" />
    </SwitchPrimitive.Root>
  )
}
