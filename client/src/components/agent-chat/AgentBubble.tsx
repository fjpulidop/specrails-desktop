import { useState, useRef, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { motion, AnimatePresence, useMotionValue } from 'motion/react'
import { Bot } from 'lucide-react'
import { useAgentChat } from '../../context/AgentChatContext'

// Persisted bubble position (top-left px). Remembered across minimize/open cycles.
const POS_KEY = 'specrails-desktop:agent-bubble-pos'
const BUBBLE = 56 // approx square footprint used for clamping
const MARGIN = 12

interface Pos { left: number; top: number }

function readStored(): Pos | null {
  try {
    const raw = localStorage.getItem(POS_KEY)
    if (!raw) return null
    const p = JSON.parse(raw)
    if (typeof p?.left === 'number' && typeof p?.top === 'number') return p
  } catch {
    /* ignore */
  }
  return null
}

function clamp(p: Pos): Pos {
  const maxLeft = Math.max(MARGIN, window.innerWidth - BUBBLE - MARGIN)
  const maxTop = Math.max(MARGIN, window.innerHeight - BUBBLE - MARGIN)
  return { left: Math.min(Math.max(MARGIN, p.left), maxLeft), top: Math.min(Math.max(MARGIN, p.top), maxTop) }
}

function defaultPos(): Pos {
  // Bottom-center.
  return { left: Math.round(window.innerWidth / 2 - BUBBLE / 2), top: window.innerHeight - BUBBLE - 20 }
}

/**
 * The persistent agent bubble. Draggable anywhere (position remembered), and the
 * single entry point when the panel is not open: click opens the agent; on
 * minimize it returns to a bubble at the last-dragged position.
 */
export function AgentBubble() {
  const { t } = useTranslation('agent')
  const { open, isStreaming, active } = useAgentChat()
  const [hovered, setHovered] = useState(false)
  const [pos, setPos] = useState<Pos>(() => clamp(readStored() ?? defaultPos()))

  // motion transform offset applied ON TOP of left/top; rebased to 0 after each drag.
  const x = useMotionValue(0)
  const y = useMotionValue(0)
  const draggedRef = useRef(false)

  // Keep the bubble on-screen when the window shrinks.
  useEffect(() => {
    const onResize = () => setPos((p) => clamp(p))
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  const persist = useCallback((p: Pos) => {
    try {
      localStorage.setItem(POS_KEY, JSON.stringify(p))
    } catch {
      /* ignore */
    }
  }, [])

  const handleClick = () => {
    if (draggedRef.current) {
      draggedRef.current = false
      return // swallow the click that follows a drag
    }
    open()
  }

  return (
    <motion.button
      type="button"
      onClick={handleClick}
      onHoverStart={() => setHovered(true)}
      onHoverEnd={() => setHovered(false)}
      aria-label={t('trigger')}
      title={`${t('trigger')} (⌘K)`}
      drag
      dragMomentum={false}
      dragElastic={0}
      style={{ position: 'fixed', left: pos.left, top: pos.top, x, y }}
      onDragStart={() => { draggedRef.current = true }}
      onDragEnd={() => {
        const next = clamp({ left: pos.left + x.get(), top: pos.top + y.get() })
        // Rebase: commit to left/top and reset the transform so nothing jumps.
        x.set(0)
        y.set(0)
        setPos(next)
        persist(next)
        // Let the click that fires right after the drag be swallowed, then re-arm.
        setTimeout(() => { draggedRef.current = false }, 0)
      }}
      initial={{ opacity: 0, scale: 0.8 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.8 }}
      transition={{ type: 'spring', stiffness: 420, damping: 28 }}
      whileHover={{ scale: 1.06 }}
      whileTap={{ scale: 0.94 }}
      whileDrag={{ scale: 1.1, cursor: 'grabbing' }}
      className="z-[60] flex h-14 items-center gap-2 rounded-full border border-border/60 bg-card/85 px-3 shadow-2xl backdrop-blur-xl cursor-grab"
    >
      <span className="relative flex h-9 w-9 items-center justify-center rounded-full bg-accent-primary/15">
        <Bot className="h-5 w-5 text-accent-primary" />
        {isStreaming && (
          <motion.span
            className="absolute inset-0 rounded-full ring-2 ring-accent-success"
            animate={{ opacity: [0.8, 0.2, 0.8], scale: [1, 1.18, 1] }}
            transition={{ duration: 1.4, repeat: Infinity, ease: 'easeInOut' }}
          />
        )}
      </span>
      <AnimatePresence initial={false}>
        {(hovered || isStreaming) && (
          <motion.span
            initial={{ opacity: 0, width: 0, marginRight: 0 }}
            animate={{ opacity: 1, width: 'auto', marginRight: 4 }}
            exit={{ opacity: 0, width: 0, marginRight: 0 }}
            transition={{ duration: 0.18, ease: 'easeOut' }}
            className="overflow-hidden whitespace-nowrap text-sm font-medium text-foreground"
          >
            {isStreaming ? t('thinking') : active?.title || t('trigger')}
          </motion.span>
        )}
      </AnimatePresence>
    </motion.button>
  )
}
