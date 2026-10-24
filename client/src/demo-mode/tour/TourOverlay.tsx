/**
 * Overlay components that render tour-specific visuals on top of the real
 * demo dashboard. All overlays anchor their position to real DOM elements
 * (via `[data-tour=…]` selectors + getBoundingClientRect) so they appear
 * INSIDE the real Specs column, INSIDE the real Rail 1 body, or fullscreen
 * for the log page — not floating at hardcoded coords.
 *
 * None of these interact with production state. All read from tourStore.
 *
 * openspec: desktop-demo-scripted-tour
 */

import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import {
  Sparkles,
  Send,
  Search,
  ChevronRight,
  Home,
  RotateCcw,
  Copy,
  Play,
  Square,
  ScrollText,
  Check,
  ArrowRight,
} from 'lucide-react'
import { tourStore } from './tour-store'
import { formatUsd } from '../../lib/format-usd'

/** Approximate height of a RailRow header row (traffic lights + label + controls).
 *  The card-in-rail must sit BELOW this so it doesn't overlap the rail title. */
const RAIL_HEADER_HEIGHT = 34

export function TourOverlay() {
  const state = useSyncExternalStore(tourStore.subscribe, tourStore.getState)

  return (
    <>
      {state.modalOpen && <TourFakeModal typedText={state.typedText} />}

      {/* The drag overlay is invisible during Beats 01-08b (the REAL 9999
          card is what the viewer sees in Specs). It only pops in at Beat 09
          start to carry the card to Rail 1. Once it reaches Rail 1 it stays
          visible through the rail-running and log-opened beats. Hidden
          entirely once the fullscreen log takes over. */}
      {!state.logDrawerOpen && state.dragOverlayStage !== 'hidden' && (
        <TourFakeSpecCard stage={state.dragOverlayStage} />
      )}
      {!state.logDrawerOpen && state.dragOverlayStage === 'at-rail' && (
        <TourFakeRail running={state.rail1Running} />
      )}

      {state.logDrawerOpen && <TourFullscreenLogPage />}
    </>
  )
}

// ─── Hook: track the rect of a `data-tour="…"` element ──────────────────────

function useAnchorRect(selector: string): DOMRect | null {
  const [rect, setRect] = useState<DOMRect | null>(null)
  useLayoutEffect(() => {
    const el = document.querySelector(selector) as HTMLElement | null
    if (!el) {
      setRect(null)
      return
    }
    const update = () => setRect(el.getBoundingClientRect())
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
    }
  }, [selector])
  return rect
}

// ─── Fake Propose Spec modal ────────────────────────────────────────────────

function TourFakeModal({ typedText }: { typedText: string }) {
  return (
    <div
      aria-hidden="true"
      data-tour-fake-modal
      style={{
        position: 'fixed',
        inset: 0,
        display: 'grid',
        placeItems: 'center',
        background: 'rgba(0, 0, 0, 0.55)',
        zIndex: 2_147_480_000,
        pointerEvents: 'none',
        animation: 'tour-fade-in 220ms ease-out',
      }}
    >
      <div
        style={{
          width: 'min(640px, 90vw)',
          background: 'hsl(231 15% 18%)',
          border: '1px solid hsl(231 15% 30% / 0.6)',
          borderRadius: 12,
          boxShadow: '0 30px 60px -15px rgba(0, 0, 0, 0.6)',
          overflow: 'hidden',
          color: 'hsl(60 30% 96%)',
        }}
      >
        <div
          style={{
            padding: '14px 20px',
            borderBottom: '1px solid hsl(231 15% 30% / 0.4)',
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            fontSize: 13,
            fontWeight: 500,
          }}
        >
          <Sparkles width={15} height={15} color="hsl(271 60% 78%)" />
          <span>Add Spec</span>
        </div>

        <div style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 14 }}>
          <p style={{ margin: 0, fontSize: 13, opacity: 0.7 }}>
            Describe the feature or change you want to propose. A spec will be generated automatically.
          </p>
          <div
            data-tour="propose-spec-textarea"
            style={{
              minHeight: 128,
              padding: '10px 14px',
              background: 'hsl(231 15% 12%)',
              border: '1px solid hsl(271 60% 78% / 0.35)',
              borderRadius: 8,
              fontSize: 13,
              fontFamily:
                '"Fira Code", "JetBrains Mono", Menlo, Monaco, Consolas, monospace',
              lineHeight: 1.55,
              color: 'hsl(60 30% 96%)',
              boxShadow: '0 0 0 3px hsl(271 60% 78% / 0.12)',
            }}
          >
            {typedText.length === 0 ? (
              <span style={{ opacity: 0.4 }}>e.g. Add a dark mode toggle...</span>
            ) : (
              <>
                {typedText}
                <span
                  aria-hidden="true"
                  style={{
                    display: 'inline-block',
                    width: 1,
                    height: 14,
                    marginLeft: 2,
                    verticalAlign: 'middle',
                    background: 'hsl(271 60% 78%)',
                    animation: 'tour-caret 0.9s step-end infinite',
                  }}
                />
              </>
            )}
          </div>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              marginTop: 4,
            }}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                fontSize: 11,
                opacity: 0.7,
              }}
            >
              <Search width={12} height={12} />
              Explore codebase
              <span style={{ opacity: 0.5, fontSize: 10 }}>~1 min</span>
            </div>
            <div
              data-tour="generate-spec-btn"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                padding: '6px 14px',
                background: 'hsl(271 60% 78%)',
                color: 'hsl(231 15% 12%)',
                borderRadius: 6,
                fontSize: 12,
                fontWeight: 500,
              }}
            >
              <Send width={13} height={13} />
              Generate Spec
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

// ─── Fake spec card: born inside Specs column, slides to Rail 1 body ────────

function TourFakeSpecCard({ stage }: { stage: 'at-specs' | 'at-rail' }) {
  const specsRect = useAnchorRect('[data-tour="specs-list"]')
  const railRect = useAnchorRect('[data-tour="rail-1"]')

  const lastSpecs = useRef<DOMRect | null>(null)
  const lastRail = useRef<DOMRect | null>(null)
  if (specsRect) lastSpecs.current = specsRect
  if (railRect) lastRail.current = railRect

  const start = lastSpecs.current
  const end = lastRail.current
  if (!start || !end) return null

  // SpecsBoard renders its active list with `px-4 py-3` = 16px side, 12px top.
  // RailRow body has `px-3 py-2` = 12px side, 8px top, PLUS a ~34px header
  // that we must clear.
  const SPECS_PAD_X = 16
  const SPECS_PAD_TOP = 12
  const RAIL_PAD_X = 12
  const RAIL_BODY_PAD_TOP = 8

  const inSpecs = {
    top: start.top + SPECS_PAD_TOP,
    left: start.left + SPECS_PAD_X,
    width: Math.max(start.width - SPECS_PAD_X * 2, 120),
  }
  const inRail = {
    top: end.top + RAIL_HEADER_HEIGHT + RAIL_BODY_PAD_TOP,
    left: end.left + RAIL_PAD_X,
    width: Math.max(end.width - RAIL_PAD_X * 2, 120),
  }
  const current = stage === 'at-rail' ? inRail : inSpecs

  return (
    <div
      aria-hidden="true"
      data-tour="new-spec-card"
      data-tour-fake-spec-card
      style={{
        position: 'fixed',
        top: current.top,
        left: current.left,
        width: current.width,
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '10px 12px',
        background: 'hsl(232 14% 31% / 0.6)',
        border: '1px solid hsl(271 60% 78% / 0.45)',
        borderRadius: 10,
        color: 'hsl(60 30% 96%)',
        boxShadow: '0 20px 40px -12px rgba(189, 147, 249, 0.25)',
        zIndex: 2_147_479_000,
        pointerEvents: 'none',
        transition:
          'top 900ms cubic-bezier(0.22, 1, 0.36, 1), left 900ms cubic-bezier(0.22, 1, 0.36, 1), width 900ms cubic-bezier(0.22, 1, 0.36, 1)',
        fontSize: 13,
        opacity: 0,
        animation: 'tour-fade-in 380ms ease-out forwards',
      }}
    >
      <span
        style={{
          fontSize: 10,
          fontFamily: 'monospace',
          color: 'hsl(225 27% 51% / 0.7)',
          flexShrink: 0,
        }}
      >
        #9999
      </span>
      <span
        style={{
          flex: 1,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        Add JWT auth with refresh tokens
      </span>
      <span
        style={{
          fontSize: 9,
          padding: '1px 6px',
          borderRadius: 4,
          background: 'hsl(265 89% 78%)',
          color: 'hsl(231 15% 18%)',
          fontWeight: 500,
          flexShrink: 0,
        }}
      >
        high
      </span>
    </div>
  )
}

// ─── Fake Rail 1 chrome: running glow + Play/Stop + Logs overlays ───────────

function TourFakeRail({ running }: { running: boolean }) {
  const railRect = useAnchorRect('[data-tour="rail-1"]')
  if (!railRect) return null

  // Real RailControls layout (right-to-left inside the rail header):
  //   [Logs icon 20px] [Mode pill ~115px: Implement | Batch] [Play button 20px]
  // Header padding-right: px-3 (12 px) + gap-1.5 (6 px × 2 between 3 items).
  // Offsets below sit the overlay EXACTLY where each real control lives.
  const playLeft = railRect.right - 32 // 12px pad + 20px button
  const playTop = railRect.top + 8
  //  Right edge …
  //   Play starts at right-32 · 6gap · Pill ends at right-38 · Pill 115px →
  //   Pill starts at right-153 · 6gap · Logs ends at right-159 → Logs starts at right-179
  const logsLeft = railRect.right - 179

  return (
    <>
      {/* Running glow ring over the real rail */}
      {running && (
        <div
          aria-hidden="true"
          data-tour-rail-running
          style={{
            position: 'fixed',
            top: railRect.top,
            left: railRect.left,
            width: railRect.width,
            height: railRect.height,
            borderRadius: 12,
            border: '1px solid hsl(142 70% 56% / 0.75)',
            boxShadow: '0 0 28px hsl(142 70% 56% / 0.55)',
            pointerEvents: 'none',
            zIndex: 2_147_478_500,
            animation: 'tour-pulse-glow 1.6s ease-in-out infinite',
          }}
        />
      )}

      {/* Play / Stop overlay — sits EXACTLY where the real Play button is
          inside the rail header, so the cursor clicks "on it". Play is
          green until the rail turns running, then flips to red Stop. */}
      <div
        data-tour="rail-1-play"
        aria-hidden="true"
        style={{
          position: 'fixed',
          top: playTop,
          left: playLeft,
          width: 20,
          height: 20,
          borderRadius: '50%',
          display: 'grid',
          placeItems: 'center',
          color: running ? 'hsl(0 100% 67%)' : 'hsl(135 94% 65%)',
          background: running
            ? 'hsl(0 100% 67% / 0.16)'
            : 'hsl(135 94% 65% / 0.16)',
          boxShadow: running
            ? '0 0 10px hsl(0 100% 67% / 0.35)'
            : '0 0 10px hsl(135 94% 65% / 0.35)',
          transition: 'color 250ms ease, background 250ms ease',
          pointerEvents: 'none',
          zIndex: 2_147_478_600,
        }}
      >
        {running ? (
          <Square width={10} height={10} fill="currentColor" strokeWidth={0} />
        ) : (
          <Play width={10} height={10} fill="currentColor" strokeWidth={0} />
        )}
      </div>

      {/* Logs overlay — only visible while running. Sits to the LEFT of the
          mode pill (Implement | Batch) per real RailControls layout. */}
      {running && (
        <div
          data-tour="rail-1-logs"
          aria-hidden="true"
          style={{
            position: 'fixed',
            top: playTop,
            left: logsLeft,
            width: 20,
            height: 20,
            borderRadius: '50%',
            display: 'grid',
            placeItems: 'center',
            color: 'hsl(191 97% 77%)',
            background: 'hsl(191 97% 77% / 0.16)',
            boxShadow: '0 0 10px hsl(191 97% 77% / 0.35)',
            pointerEvents: 'none',
            zIndex: 2_147_478_600,
          }}
        >
          <ScrollText width={10} height={10} strokeWidth={2} />
        </div>
      )}
    </>
  )
}

// ─── Fullscreen fake log page (mimics JobDetailPage layout) ─────────────────

function TourFullscreenLogPage() {
  const state = useSyncExternalStore(tourStore.subscribe, tourStore.getState)
  const logRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = logRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [state.logLines])

  const visibleCount = state.logLines.length
  const totalCount = 11
  const lastLine = state.logLines[state.logLines.length - 1]
  const isDone =
    visibleCount >= totalCount && lastLine?.text.includes('SHIPPED')

  return (
    <div
      aria-hidden="true"
      data-tour-fullscreen-log
      style={{
        position: 'fixed',
        inset: 0,
        background: 'hsl(231 15% 14%)',
        zIndex: 2_147_478_000,
        pointerEvents: 'none',
        animation: 'tour-fade-in 260ms ease-out',
        display: 'flex',
        flexDirection: 'column',
        color: 'hsl(60 30% 96%)',
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          maxWidth: 1024,
          margin: '0 auto',
          width: '100%',
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        {/* Breadcrumb + title row */}
        <div
          style={{
            padding: '16px 24px',
            borderBottom: '1px solid hsl(231 15% 30% / 0.5)',
            display: 'flex',
            flexDirection: 'column',
            gap: 12,
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              fontSize: 12,
              color: 'hsl(225 27% 70%)',
            }}
          >
            <Home width={12} height={12} />
            <span>Dashboard</span>
            <ChevronRight width={12} height={12} style={{ opacity: 0.5 }} />
            <span
              style={{
                color: 'hsl(60 30% 96%)',
                fontFamily: 'monospace',
                letterSpacing: 0.2,
              }}
            >
              Job #ab3c91f0
            </span>
          </div>

          <div
            style={{
              display: 'flex',
              alignItems: 'flex-start',
              justifyContent: 'space-between',
              gap: 16,
            }}
          >
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  flexWrap: 'wrap',
                }}
              >
                <TourStatusBadge running={!isDone} done={isDone ?? false} />
                <code
                  style={{
                    fontSize: 13,
                    fontFamily: 'monospace',
                    color: 'hsl(60 30% 96% / 0.9)',
                  }}
                >
                  /specrails:implement #9 --yes
                </code>
              </div>
              <div style={{ fontSize: 11, color: 'hsl(225 27% 70%)' }}>
                Started just now · claude-sonnet-4-20250514
              </div>
            </div>

            {/* Re-execute button (only once done — matches real JobDetailPage) */}
            {isDone && (
              <div
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  padding: '5px 10px',
                  border: '1px solid hsl(231 15% 30% / 0.6)',
                  borderRadius: 6,
                  fontSize: 11,
                  color: 'hsl(60 30% 96%)',
                }}
              >
                <RotateCcw width={12} height={12} />
                Run again
              </div>
            )}
          </div>
        </div>

        {/* Completion / running summary card */}
        <div style={{ padding: '16px 24px' }}>
          <TourSummaryCard
            done={isDone ?? false}
            progress={totalCount > 0 ? visibleCount / totalCount : 0}
          />
        </div>

        {/* Filter + line count bar */}
        <div
          style={{
            padding: '0 24px 12px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              flex: 1,
              maxWidth: 360,
              padding: '6px 10px',
              border: '1px solid hsl(231 15% 30% / 0.5)',
              borderRadius: 6,
              fontSize: 12,
              color: 'hsl(225 27% 70%)',
            }}
          >
            <Search width={12} height={12} />
            <span>Filter logs...</span>
          </div>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              fontSize: 11,
              color: 'hsl(225 27% 70%)',
            }}
          >
            <Copy width={12} height={12} />
            <span>
              {visibleCount} / {totalCount} lines
            </span>
          </div>
        </div>

        {/* Log body */}
        <div
          ref={logRef}
          style={{
            flex: 1,
            padding: '4px 24px 24px',
            fontFamily: '"Fira Code", Menlo, Monaco, monospace',
            fontSize: 13,
            lineHeight: 1.85,
            overflow: 'auto',
          }}
        >
          {state.logLines.map((line) => (
            <div key={line.id} style={{ animation: 'tour-fade-in 200ms ease-out' }}>
              <span style={{ color: 'hsl(231 15% 55%)' }}>{line.timestamp}</span>
              {'  '}
              <span
                style={{
                  color:
                    line.marker === '✓'
                      ? 'hsl(142 70% 56%)'
                      : 'hsl(271 60% 78%)',
                  fontWeight: 600,
                }}
              >
                {line.marker === '✓'
                  ? <Check size={13} strokeWidth={2.5} aria-hidden style={{ display: 'inline', verticalAlign: '-2px' }} />
                  : <ArrowRight size={13} strokeWidth={2.5} aria-hidden style={{ display: 'inline', verticalAlign: '-2px' }} />}
              </span>
              {'  '}
              <TourLogLineText text={line.text} />
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

function TourStatusBadge({ running, done }: { running: boolean; done: boolean }) {
  const bg = done
    ? 'hsl(142 70% 56% / 0.15)'
    : running
      ? 'hsl(271 60% 78% / 0.15)'
      : 'hsl(231 15% 30% / 0.4)'
  const color = done
    ? 'hsl(142 70% 56%)'
    : running
      ? 'hsl(271 60% 78%)'
      : 'hsl(225 27% 70%)'
  const label = done ? 'completed' : running ? 'running' : 'queued'
  return (
    <span
      style={{
        padding: '2px 10px',
        borderRadius: 999,
        background: bg,
        color,
        fontSize: 11,
        fontWeight: 500,
        textTransform: 'lowercase',
        letterSpacing: 0.3,
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
      }}
    >
      <span
        style={{
          width: 5,
          height: 5,
          borderRadius: '50%',
          background: color,
          animation: running ? 'tour-pulse-dot 1.2s ease-in-out infinite' : undefined,
        }}
      />
      {label}
    </span>
  )
}

function TourSummaryCard({ done, progress }: { done: boolean; progress: number }) {
  const accent = done ? 'hsl(142 70% 56%)' : 'hsl(271 60% 78%)'
  const title = done ? 'Job completed' : 'Job running...'

  // Progressive stats. At progress=0 everything is at the "just started"
  // baseline; at progress=1 they match the final SHIPPED values. Real app
  // JobDetailPage shows 0 / $0 / 0 / 0 while a fresh job is running and
  // ticks up from the event stream — this mirrors that rhythm.
  const totalSec = 24 * 60 + 21 // 1461 s
  const curSec = Math.round(totalSec * progress)
  const mins = Math.floor(curSec / 60)
  const secs = curSec % 60
  const durationLabel = `${mins}m ${secs.toString().padStart(2, '0')}s`
  const costLabel = formatUsd(6.2408 * progress)
  const turnsLabel = `${Math.round(16 * progress)}`
  const tokensValue = 5.9 * progress
  const tokensLabel = tokensValue >= 0.1 ? `${tokensValue.toFixed(1)}k` : '0'

  return (
    <div
      style={{
        border: '1px solid',
        borderColor: `color-mix(in srgb, ${accent} 40%, transparent)`,
        borderRadius: 12,
        background: `color-mix(in srgb, ${accent} 4%, transparent)`,
        padding: 16,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          fontSize: 14,
          fontWeight: 600,
          marginBottom: 14,
        }}
      >
        <span
          style={{
            width: 18,
            height: 18,
            borderRadius: '50%',
            border: `2px solid ${accent}`,
            display: 'grid',
            placeItems: 'center',
            fontSize: 11,
            color: accent,
          }}
        >
          {done ? <Check size={11} strokeWidth={3} aria-hidden /> : '…'}
        </span>
        {title}
      </div>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(4, 1fr)',
          gap: 10,
        }}
      >
        {[
          ['DURATION', durationLabel],
          ['COST', costLabel],
          ['TURNS', turnsLabel],
          ['TOKENS', tokensLabel],
        ].map(([label, value]) => (
          <div
            key={label}
            style={{
              padding: '10px 12px',
              border: '1px solid hsl(231 15% 30% / 0.35)',
              borderRadius: 8,
              background: 'hsl(231 15% 10% / 0.3)',
            }}
          >
            <div
              style={{
                fontSize: 10,
                letterSpacing: 1,
                color: 'hsl(225 27% 70%)',
                marginBottom: 4,
              }}
            >
              {label}
            </div>
            <div
              style={{
                fontSize: 14,
                fontWeight: 600,
                fontVariantNumeric: 'tabular-nums',
              }}
            >
              {value}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function TourLogLineText({ text }: { text: string }) {
  const parts = text.split(/(SHIPPED|PASS|\d+)/g)
  return (
    <>
      {parts.map((part, i) => {
        if (part === 'SHIPPED' || part === 'PASS') {
          return (
            <span key={i} style={{ color: 'hsl(142 70% 56%)', fontWeight: 700 }}>
              {part}
            </span>
          )
        }
        if (/^\d+$/.test(part)) {
          return (
            <span key={i} style={{ color: 'hsl(191 97% 77%)' }}>
              {part}
            </span>
          )
        }
        return <span key={i}>{part}</span>
      })}
    </>
  )
}
