import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { render, screen } from '@testing-library/react'
import { AlertTriangle, CheckCircle2, Circle, CircleSlash, Eye, GitPullRequest, MessageCircleQuestion, PauseCircle, XCircle } from 'lucide-react'
import { RUN_STATES, RUN_STATE_LOOK, isRunState, runStateLook, type RunState } from '../run-state/run-state'
import { RunStateGlyph } from '../run-state/run-state-glyph'
import { RunStateDot } from '../run-state/run-state-dot'
import { RunStatePill } from '../run-state/run-state-pill'
import { setA11yPrefs, resetA11yPrefsCache, applyA11yPrefs, DEFAULT_A11Y_PREFS } from '../../../lib/a11y-prefs'

const LOCALES = path.resolve(__dirname, '../../../locales')

describe('run-state table', () => {
  it('has exactly one look per state', () => {
    expect(Object.keys(RUN_STATE_LOOK).sort()).toEqual([...RUN_STATES].sort())
  })

  it('pins each state to its tone and glyph', () => {
    const expected: Record<RunState, [string, unknown]> = {
      queued: ['text-muted-foreground', Circle],
      working: ['text-accent-info', null],
      'needs-input': ['text-accent-primary', MessageCircleQuestion],
      review: ['text-accent-review', Eye],
      paused: ['text-accent-warning', PauseCircle],
      blocked: ['text-accent-warning', AlertTriangle],
      failed: ['text-destructive', XCircle],
      done: ['text-accent-success', CheckCircle2],
      stopped: ['text-muted-foreground', CircleSlash],
    }
    for (const state of RUN_STATES) {
      expect([runStateLook(state).text, runStateLook(state).icon], state).toEqual(expected[state])
    }
  })

  it('reserves primary for needs-input, the triangle for blocked and the warning tone', () => {
    const primary = RUN_STATES.filter((s) => runStateLook(s).text === 'text-accent-primary')
    expect(primary).toEqual(['needs-input'])
    const triangles = RUN_STATES.filter((s) => runStateLook(s).icon === AlertTriangle)
    expect(triangles).toEqual(['blocked'])
    expect(runStateLook('blocked').text).toBe('text-accent-warning')
    // Running is never success.
    expect(runStateLook('working').dot).toBe('bg-accent-info')
  })

  it('names every state in all eight locales', () => {
    for (const locale of fs.readdirSync(LOCALES)) {
      const common = JSON.parse(fs.readFileSync(path.join(LOCALES, locale, 'common.json'), 'utf8'))
      for (const state of RUN_STATES) {
        expect(typeof common.runState?.[state], `${locale} runState.${state}`).toBe('string')
        expect(typeof common.runState?.hint?.[state], `${locale} runState.hint.${state}`).toBe('string')
      }
    }
  })

  it('recognises states', () => {
    expect(isRunState('needs-input')).toBe(true)
    expect(isRunState('running')).toBe(false)
    expect(isRunState(undefined)).toBe(false)
  })
})

describe('RunStateGlyph / RunStateDot', () => {
  afterEach(() => { localStorage.clear(); resetA11yPrefsCache(); applyA11yPrefs(DEFAULT_A11Y_PREFS) })

  it('draws the pulsing info lamp for working, and only for working', () => {
    for (const state of RUN_STATES) {
      const { container, unmount } = render(<><RunStateGlyph state={state} /><RunStateDot state={state} /></>)
      const rings = container.querySelectorAll('[data-live-ring]')
      expect(rings.length, state).toBe(state === 'working' ? 2 : 0)
      unmount()
    }
  })

  it('keeps a quiet working lamp lit without the ring', () => {
    const { container } = render(<><RunStateGlyph state="working" quiet /><RunStateDot state="working" quiet /></>)
    expect(container.querySelector('[data-live-ring]')).toBeNull()
    expect(container.querySelectorAll('.bg-accent-info').length).toBe(2)
  })

  it('stops pulsing under reduced motion', () => {
    setA11yPrefs({ motion: 'reduce' })
    const { container } = render(<RunStateDot state="working" />)
    expect(container.querySelector('[data-live-ring]')).toBeNull()
    expect(container.querySelector('.bg-accent-info')).toBeInTheDocument()
  })

  it('draws the failed glyph as XCircle in the destructive tone', () => {
    const { container } = render(<RunStateGlyph state="failed" />)
    const root = container.querySelector('[data-run-state="failed"]')
    expect(root).toHaveClass('text-destructive')
    expect(root?.querySelector('svg')).toBeInTheDocument()
    expect(root).toHaveAttribute('aria-hidden', 'true')
  })

  it('names the glyph when labelled, and keeps the tone for an object glyph', () => {
    render(<RunStateGlyph state="review" objectIcon={GitPullRequest} label="Ready" />)
    const glyph = screen.getByRole('img', { name: 'Ready' })
    expect(glyph).toHaveClass('text-accent-review')
    expect(glyph.querySelector('svg')).toBeInTheDocument()
  })

  it('draws queued hollow and needs-input ringed', () => {
    const { container } = render(<><RunStateDot state="queued" /><RunStateDot state="needs-input" /></>)
    expect(container.querySelector('[data-run-state="queued"] .border-muted-foreground')).toBeInTheDocument()
    expect(container.querySelector('[data-run-state="needs-input"] .ring-accent-primary\\/20')).toBeInTheDocument()
  })
})

describe('RunStatePill', () => {
  it('shows the localized state name by default', () => {
    render(<RunStatePill state="stopped" data-testid="pill" />)
    const pill = screen.getByTestId('pill')
    expect(pill).toHaveTextContent('Stopped')
    expect(pill).toHaveAttribute('data-run-state', 'stopped')
    expect(pill).toHaveClass('text-muted-foreground')
  })

  it('takes more specific words and pulses only while working', () => {
    const { container } = render(<RunStatePill state="working" label="Iterating" />)
    expect(screen.getByText('Iterating')).toBeInTheDocument()
    expect(container.querySelector('[data-live-ring]')).toBeInTheDocument()
  })
})

describe('Badge running variant', () => {
  it('pulses its lamp through LiveDot; other variants stay static', async () => {
    const { Badge } = await import('../badge')
    const { container, rerender } = render(<Badge variant="running">Running</Badge>)
    expect(container.querySelector('[data-badge-lamp] [data-live-ring]')).toBeInTheDocument()
    rerender(<Badge variant="success">Done</Badge>)
    expect(container.querySelector('[data-live-ring]')).toBeNull()
  })
})
