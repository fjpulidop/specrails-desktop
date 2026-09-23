import { useEffect, useRef } from 'react'

interface Props {
  x: number
  y: number
  label: string
  onSelect: () => void
  onClose: () => void
}

/**
 * Tiny single-item context menu used for right-click on the topbar shortcut
 * buttons. Visually matches TerminalContextMenu so it feels native to the
 * panel.
 */
export function ShortcutContextMenu({ x, y, label, onSelect, onClose }: Props) {
  const ref = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('mousedown', onDocClick)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDocClick)
      document.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  // Flip when near right/bottom edges so the menu does not overflow.
  const flippedX = typeof window !== 'undefined' && x + 220 > window.innerWidth ? x - 220 : x
  const flippedY = typeof window !== 'undefined' && y + 60 > window.innerHeight ? y - 60 : y

  return (
    <div
      ref={ref}
      role="menu"
      data-shortcut-context-menu
      style={{ position: 'fixed', left: flippedX, top: flippedY, minWidth: 200 }}
      className="bg-[#1f1f29] border border-[#44475a] rounded-md shadow-lg py-1 z-50 text-sm"
    >
      <button
        type="button"
        role="menuitem"
        onClick={() => { onSelect(); onClose() }}
        className="w-full text-left px-3 py-1.5 text-[#f8f8f2] hover:bg-[#44475a]"
      >
        {label}
      </button>
    </div>
  )
}
