import { useState, useRef, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { motion, AnimatePresence, useMotionValue } from 'motion/react'
import { Bot } from 'lucide-react'
import { useAgentChat } from '../context/AgentChatContext'
import { BuilderHalo } from '../../builder/components/project-builder/BuilderHalo'

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

// Default spot: bottom-right (16px from the right, 40px above the bottom —
// clear of the status bar), so it no longer covers centred content such as
// the job Story list or the code tree.
const DEFAULT_RIGHT = 16
const DEFAULT_BOTTOM = 40

function defaultPos(): Pos {
  return { left: window.innerWidth - BUBBLE - DEFAULT_RIGHT, top: window.innerHeight - BUBBLE - DEFAULT_BOTTOM }
}

/**
 * The persistent agent bubble. Draggable anywhere (position remembered), and the
 * single entry point when the panel is not open: click opens the agent; on
 * minimize it returns to a bubble at the last-dragged position.
 */
export function AgentBubble() {
  const { t } = useTranslation('agent')
  const { t: tBuilder } = useTranslation('builder')
  const { open, isStreaming, active, builderMode } = useAgentChat()
  const [hovered, setHovered] = useState(false)
  const [pos, setPos] = useState<Pos>(() => clamp(readStored() ?? defaultPos()))

  // motion transform offset applied ON TOP of left/top; rebased to 0 after each drag.
  const x = useMotionValue(0)
  const y = useMotionValue(0)
  const draggedRef = useRef(false)
  const showingActivity = builderMode.active ? builderMode.session.busy : isStreaming

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

  // On the right half the bubble grows leftwards (anchored by `right`), so the
  // hover/activity label never spills off-screen at the default bottom-right.
  const anchorRight = pos.left + BUBBLE / 2 > window.innerWidth / 2
  const anchorStyle = anchorRight
    ? { right: window.innerWidth - pos.left - BUBBLE, top: pos.top }
    : { left: pos.left, top: pos.top }
  const labelMargin = anchorRight ? 'marginLeft' : 'marginRight'

  return (
    <motion.button
      type="button"
      onClick={handleClick}
      onHoverStart={() => setHovered(true)}
      onHoverEnd={() => setHovered(false)}
      aria-label={t('trigger')}
      title={`${t('trigger')} (⌘⇧A)`}
      drag
      dragMomentum={false}
      dragElastic={0}
      style={{ position: 'fixed', ...anchorStyle, x, y }}
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
      className={`z-[60] flex h-14 items-center gap-2 rounded-full${anchorRight ? ' flex-row-reverse' : ''} border border-border/60 bg-card px-3 shadow-2xl cursor-grab`}
    >
      <span className="relative flex h-9 w-9 items-center justify-center rounded-full bg-accent-primary/15">
        <BuilderHalo
          active={builderMode.active && builderMode.session.messages.length === 0 && builderMode.session.phase === 'chat'}
          inset={-4}
        />
        <Bot className="h-5 w-5 text-accent-primary" />
        {showingActivity && (
          <motion.span
            className="absolute inset-0 rounded-full ring-2 ring-accent-success"
            animate={{ opacity: [0.8, 0.2, 0.8], scale: [1, 1.18, 1] }}
            transition={{ duration: 1.4, repeat: Infinity, ease: 'easeInOut' }}
          />
        )}
      </span>
      <AnimatePresence initial={false}>
        {(hovered || showingActivity) && (
          <motion.span
            initial={{ opacity: 0, width: 0, [labelMargin]: 0 }}
            animate={{ opacity: 1, width: 'auto', [labelMargin]: 4 }}
            exit={{ opacity: 0, width: 0, [labelMargin]: 0 }}
            transition={{ duration: 0.18, ease: 'easeOut' }}
            className="overflow-hidden whitespace-nowrap text-sm font-medium text-foreground"
          >
            {showingActivity ? t('thinking') : builderMode.active ? tBuilder('mode.title') : active?.title || t('trigger')}
          </motion.span>
        )}
      </AnimatePresence>
    </motion.button>
  )
}
