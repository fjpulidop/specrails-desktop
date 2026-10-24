import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowLeft, ArrowRight } from 'lucide-react'
import { usePlaceHistory, type PlaceHistoryValue, type PlaceTarget } from '../hooks/usePlaceHistory'
import { isMacKeyboard, keyboardLabel } from '../lib/keyboard-label'
import { cn } from '../lib/utils'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from './ui/dropdown-menu'

const LONG_PRESS_MS = 500

function PlaceNavButton({ direction, places }: { direction: 'back' | 'forward'; places: PlaceHistoryValue }) {
  const { t } = useTranslation('nav')
  const enabled = direction === 'back' ? places.canBack : places.canForward
  const target = direction === 'back' ? places.backTarget : places.forwardTarget
  const [menuOpen, setMenuOpen] = useState(false)
  const [items, setItems] = useState<PlaceTarget[]>([])
  const pressTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const longPressed = useRef(false)
  const Icon = direction === 'back' ? ArrowLeft : ArrowRight

  const openMenu = useCallback(() => {
    const list = places.list(direction)
    if (list.length === 0) return
    setItems(list)
    setMenuOpen(true)
  }, [places, direction])

  const cancelPress = useCallback(() => {
    if (pressTimer.current) clearTimeout(pressTimer.current)
    pressTimer.current = null
  }, [])
  useEffect(() => cancelPress, [cancelPress])

  const label = target
    ? t(direction === 'back' ? 'titleBar.backTo' : 'titleBar.forwardTo', { place: target.label })
    : t(direction === 'back' ? 'titleBar.back' : 'titleBar.forward')
  const shortcut = keyboardLabel(direction === 'back' ? '⌘[' : '⌘]')
  const bracket = direction === 'back' ? 'BracketLeft' : 'BracketRight'
  const arrow = direction === 'back' ? 'ArrowLeft' : 'ArrowRight'
  const ariaShortcuts = isMacKeyboard() ? `Meta+${bracket}` : `Control+${bracket} Alt+${arrow}`

  return (
    <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
      <DropdownMenuTrigger
        aria-label={label}
        title={t('sidebarPin.withShortcut', { label, shortcut })}
        aria-keyshortcuts={ariaShortcuts}
        disabled={!enabled}
        data-testid={`place-nav-${direction}`}
        onClick={(e) => {
          // The click is a navigation, never the menu toggle.
          e.preventDefault()
          if (longPressed.current) { longPressed.current = false; return }
          if (direction === 'back') places.back()
          else places.forward()
        }}
        onPointerDown={(e) => {
          if (e.button !== 0 || !enabled) return
          longPressed.current = false
          cancelPress()
          pressTimer.current = setTimeout(() => {
            pressTimer.current = null
            longPressed.current = true
            openMenu()
          }, LONG_PRESS_MS)
        }}
        onKeyDown={(e) => { if (e.key === 'ArrowDown') setItems(places.list(direction)) }}
        onPointerUp={cancelPress}
        onPointerLeave={cancelPress}
        onPointerCancel={cancelPress}
        onContextMenu={(e) => {
          e.preventDefault()
          cancelPress()
          if (enabled) openMenu()
        }}
        className={cn(
          'flex h-6 w-7 shrink-0 items-center justify-center rounded text-muted-foreground focus-visible:outline focus-visible:outline-ring',
          'hover:bg-muted/50 hover:text-foreground',
          'disabled:pointer-events-none disabled:opacity-40',
        )}
        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
      >
        <Icon className="h-4 w-4" aria-hidden />
      </DropdownMenuTrigger>
      {items.length > 0 && (
        <DropdownMenuContent align="start" aria-label={t(direction === 'back' ? 'titleBar.backMenu' : 'titleBar.forwardMenu')}>
          {items.map((item) => (
            <DropdownMenuItem key={item.idx} onSelect={() => places.goTo(item.idx)}>
              <span className="max-w-[18rem] truncate">{item.label}</span>
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      )}
    </DropdownMenu>
  )
}

/**
 * ← → in the title bar: step through the places the person has been (specs,
 * missions, jobs, projects...). Right-click or long-press lists the last ones.
 * Renders nothing outside the main window (no place history there).
 */
export function PlaceNavButtons() {
  const { t } = useTranslation('nav')
  const places = usePlaceHistory()
  if (!places) return null
  return (
    <div className="flex items-center" role="group" aria-label={t('titleBar.history')}>
      <PlaceNavButton direction="back" places={places} />
      <PlaceNavButton direction="forward" places={places} />
    </div>
  )
}
