import * as SelectPrimitive from '@radix-ui/react-select'
import { Check, ChevronDown, ChevronUp, type LucideIcon } from 'lucide-react'

export const AGENT_SELECTOR_TRIGGER_CLASS =
  'flex min-w-0 items-center gap-1.5 rounded-md px-1.5 py-1 text-sm font-medium text-foreground outline-none transition-colors hover:bg-surface/70 focus-visible:ring-2 focus-visible:ring-accent-primary/50 disabled:cursor-not-allowed disabled:opacity-50'

export const AGENT_SELECTOR_POPOVER_CLASS =
  'overflow-hidden rounded-xl border border-border/60 bg-card/95 shadow-2xl backdrop-blur-xl'

export const AGENT_SELECTOR_ROW_CLASS =
  'flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-sm text-foreground outline-none hover:bg-surface/70 focus-visible:bg-surface/70'

export interface AgentToolbarOption {
  value: string
  label: string
  icon?: LucideIcon
}

interface Props {
  label: string
  value: string
  options: AgentToolbarOption[]
  icon: LucideIcon
  onSelect: (value: string) => void
  placeholder?: string
  disabled?: boolean
  testId?: string
}

/**
 * Compact, themed selector shared by the Agent composer controls. It mirrors
 * AgentProjectSelector's light trigger + glass menu, while Radix owns focus,
 * typeahead, collision handling and listbox keyboard semantics.
 */
export function AgentToolbarSelector({
  label,
  value,
  options,
  icon: TriggerIcon,
  onSelect,
  placeholder,
  disabled = false,
  testId,
}: Props) {
  return (
    <SelectPrimitive.Root
      value={value}
      onValueChange={onSelect}
      disabled={disabled || options.length === 0}
    >
      <SelectPrimitive.Trigger
        aria-label={label}
        title={label}
        data-agent-interactive
        data-testid={testId}
        className={AGENT_SELECTOR_TRIGGER_CLASS}
      >
        <TriggerIcon className="h-3.5 w-3.5 shrink-0 text-accent-primary" aria-hidden />
        <SelectPrimitive.Value
          placeholder={placeholder ?? label}
          className="max-w-[160px] truncate"
        />
        <SelectPrimitive.Icon asChild>
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-foreground/50" />
        </SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>

      <SelectPrimitive.Portal>
        <SelectPrimitive.Content
          position="popper"
          side="top"
          align="start"
          sideOffset={4}
          collisionPadding={8}
          className={`z-[80] min-w-[12rem] max-w-[20rem] ${AGENT_SELECTOR_POPOVER_CLASS} data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=open]:fade-in-0 data-[state=closed]:fade-out-0 data-[state=open]:zoom-in-95 data-[state=closed]:zoom-out-95 data-[side=bottom]:slide-in-from-top-1 data-[side=top]:slide-in-from-bottom-1`}
        >
          <SelectPrimitive.ScrollUpButton className="flex items-center justify-center py-1 text-foreground/50">
            <ChevronUp className="h-3.5 w-3.5" />
          </SelectPrimitive.ScrollUpButton>
          <SelectPrimitive.Viewport className="max-h-72 py-1">
            {options.map((option) => {
              const OptionIcon = option.icon ?? TriggerIcon
              return (
                <SelectPrimitive.Item
                  key={option.value}
                  value={option.value}
                  className={`${AGENT_SELECTOR_ROW_CLASS} relative cursor-default select-none pr-9 data-[highlighted]:bg-surface/70 data-[state=checked]:font-medium`}
                >
                  <OptionIcon className="h-4 w-4 shrink-0 text-accent-primary" aria-hidden />
                  <SelectPrimitive.ItemText>
                    <span className="truncate">{option.label}</span>
                  </SelectPrimitive.ItemText>
                  <SelectPrimitive.ItemIndicator className="absolute right-3 flex items-center">
                    <Check className="h-3.5 w-3.5 text-accent-primary" />
                  </SelectPrimitive.ItemIndicator>
                </SelectPrimitive.Item>
              )
            })}
          </SelectPrimitive.Viewport>
          <SelectPrimitive.ScrollDownButton className="flex items-center justify-center py-1 text-foreground/50">
            <ChevronDown className="h-3.5 w-3.5" />
          </SelectPrimitive.ScrollDownButton>
        </SelectPrimitive.Content>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  )
}
