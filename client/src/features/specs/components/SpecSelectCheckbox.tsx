import { Check } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { cn } from '../../../lib/utils'
import type { LocalTicket } from '../../../types'
import type { SelectGesture } from '../lib/board-selection'

/** Selection state a board hands to each card (absent = the card is not selectable, e.g. inside a rail). */
export interface CardSelection {
  selected: boolean
  /** At least one spec is selected: the checkbox stays visible on every card. */
  active: boolean
  onSelect: (ticket: LocalTicket, gesture: SelectGesture) => void
}

/** Card classes for the selected state (token-based; calm, no halo). */
export const SELECTED_CARD_CLASS = 'border-accent-primary/70 bg-accent-primary/10 ring-1 ring-accent-primary/50'

interface SpecSelectCheckboxProps {
  ticket: Pick<LocalTicket, 'id'>
  selection: CardSelection
  className?: string
  onToggle: () => void
}

/**
 * The checkbox affordance on a spec card: hidden until the card is hovered or
 * focused (or a selection exists), always visible once selected. A real button,
 * so it works with a pointer and with the keyboard (Tab, Space/Enter); the board
 * also answers `x` on a focused card.
 */
export function SpecSelectCheckbox({ ticket, selection, className, onToggle }: SpecSelectCheckboxProps) {
  const { t } = useTranslation('specs')
  const visible = selection.selected || selection.active
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={selection.selected}
      aria-label={t('bulk.selectSpec', { id: ticket.id })}
      data-testid={`spec-select-${ticket.id}`}
      onClick={(e) => { e.stopPropagation(); onToggle() }}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === ' ' || e.key === 'Enter') {
          e.stopPropagation()
          e.preventDefault()
          onToggle()
        }
      }}
      className={cn(
        'inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-[4px] border transition-opacity focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        selection.selected
          ? 'border-accent-primary bg-accent-primary text-background'
          : 'border-border bg-background/80 text-transparent hover:border-accent-primary/70',
        visible ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100',
        className,
      )}
    >
      <Check className="h-3 w-3" strokeWidth={3} aria-hidden />
    </button>
  )
}
