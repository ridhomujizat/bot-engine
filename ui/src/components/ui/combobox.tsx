import { Check, ChevronsUpDown } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { Button } from './button'
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from './command'
import { Popover, PopoverContent, PopoverTrigger } from './popover'

export interface ComboboxOption {
  value: string
  label: string
  /** Muted text after the label (for example a preview). */
  detail?: string
  /** Small pill before the label (for example a content type). */
  badge?: string
}

export interface ComboboxProps {
  /** Accessible name of the trigger and the search field. */
  label: string
  value: string
  onValueChange: (value: string) => void
  options: ComboboxOption[]
  /** Text on the trigger when nothing is chosen (or the chosen value is not in the options). */
  placeholder?: string
  searchPlaceholder?: string
  emptyText?: string
  /** Options listed above the others, before the search results (for example "New..."). */
  leading?: ComboboxOption[]
  disabled?: boolean
  className?: string
  id?: string
}

/**
 * shadcn Combobox: a Popover with a searchable Command list. Arrow keys move, Enter chooses, Escape
 * closes. Used for long lists (actions, nodes, flows, content elements).
 */
export function Combobox({
  label,
  value,
  onValueChange,
  options,
  placeholder = 'Choose...',
  searchPlaceholder = 'Search...',
  emptyText = 'No matches',
  leading = [],
  disabled,
  className,
  id,
}: ComboboxProps) {
  const [open, setOpen] = useState(false)
  const all = [...leading, ...options]
  const chosen = all.find((o) => o.value === value)

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          id={id}
          type="button"
          variant="outline"
          role="combobox"
          aria-label={label}
          aria-expanded={open}
          disabled={disabled}
          className={cn('h-8 w-full min-w-0 justify-between overflow-hidden px-2.5 font-normal text-[13px]', className)}
        >
          <Current option={chosen} placeholder={placeholder} />
          <ChevronsUpDown className="size-3.5 shrink-0 text-muted-foreground" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="p-0">
        <Command>
          <CommandInput aria-label={`Search ${label.toLowerCase()}`} placeholder={searchPlaceholder} />
          <CommandList>
            <CommandEmpty>{emptyText}</CommandEmpty>
            {leading.length > 0 && (
              <CommandGroup>
                {leading.map((o) => (
                  <Row key={`lead-${o.value}`} option={o} selected={o.value === value} onPick={() => pick(o.value)} />
                ))}
              </CommandGroup>
            )}
            <CommandGroup>
              {options.map((o) => (
                <Row key={o.value} option={o} selected={o.value === value} onPick={() => pick(o.value)} />
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )

  function pick(next: string) {
    setOpen(false)
    if (next !== value) onValueChange(next)
  }
}

function Current({ option, placeholder }: { option: ComboboxOption | undefined; placeholder: string }) {
  if (!option) return <span className="min-w-0 flex-1 truncate text-left text-muted-foreground">{placeholder}</span>
  return (
    <span className="min-w-0 flex-1 text-left" title={option.label}>
      <OptionText option={option} />
    </span>
  )
}

function Row({ option, selected, onPick }: { option: ComboboxOption; selected: boolean; onPick: () => void }) {
  return (
    <CommandItem value={option.value} keywords={[option.label, option.detail ?? '']} onSelect={onPick}>
      <OptionText option={option} />
      <Check className={cn('ml-auto size-3.5 shrink-0', selected ? 'opacity-100' : 'opacity-0')} />
    </CommandItem>
  )
}

function OptionText({ option }: { option: ComboboxOption }): ReactNode {
  return (
    <span className="flex min-w-0 items-center gap-2">
      {option.badge && (
        <span className="shrink-0 rounded bg-muted px-1.5 py-px text-[11px] font-medium text-muted-foreground">{option.badge}</span>
      )}
      <span className="min-w-0 truncate">{option.label}</span>
      {option.detail && <span className="min-w-0 truncate text-muted-foreground">{option.detail}</span>}
    </span>
  )
}
