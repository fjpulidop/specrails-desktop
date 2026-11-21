import { describe, expect, it } from 'vitest'
import { RUN_HOLD_KINDS } from '../../../modules/loops/runtime/loop-run-hold'
import { CANONICAL_STATUSES, appState, isSettled, statusFromChain, statusFromDelivery, statusFromHold, statusFromJob, statusFromRunHold, statusFromSpec, statusFromWord } from './status-map'
import { t } from './lang'

describe('status vocabulary', () => {
  it('maps every canonical status to one of the app\'s nine run states with a label in every language', () => {
    const app = new Set(['queued', 'working', 'needs-input', 'review', 'paused', 'blocked', 'failed', 'done', 'stopped'])
    for (const status of CANONICAL_STATUSES) {
      expect(app.has(appState(status)), status).toBe(true)
      expect(t('en', `core.status.${status}`)).not.toBe(`core.status.${status}`)
      expect(t('es', `core.status.${status}`)).not.toBe(`core.status.${status}`)
    }
    expect(t('es', 'core.status.running')).toBe('En curso')
  })

  it('maps job rows, using the hold of a running job', () => {
    expect(statusFromJob('queued')).toBe('queued')
    expect(statusFromJob('running')).toBe('running')
    expect(statusFromJob('running', { kind: 'question' })).toBe('needs_you')
    expect(statusFromJob('running', { kind: 'provider_limit' })).toBe('blocked')
    expect(statusFromJob('completed')).toBe('succeeded')
    expect(statusFromJob('zombie_terminated')).toBe('failed')
    expect(statusFromJob('skipped')).toBe('cancelled')
    expect(statusFromRunHold('running', 'stuck')).toBe('blocked')
    expect(statusFromRunHold('running', 'approval')).toBe('needs_you')
    expect(statusFromRunHold('running', 'unknown-hold')).toBe('running')
    expect(statusFromWord('stuck')).toBe('blocked')
    for (const kind of RUN_HOLD_KINDS) expect(CANONICAL_STATUSES).toContain(statusFromHold({ kind }))
  })

  it('maps deliveries, chains and specs', () => {
    expect(['on_review', 'pr_draft', 'pr_ready'].map(statusFromDelivery)).toEqual(['ready_for_review', 'ready_for_review', 'ready_for_review'])
    expect(statusFromDelivery('merged')).toBe('integrated')
    expect(statusFromDelivery('completed')).toBe('delivered')
    expect(statusFromDelivery('superseded')).toBe('discarded')
    expect(statusFromDelivery('pr_failed')).toBe('failed')
    expect(statusFromChain('awaiting_approval')).toBe('needs_you')
    expect(statusFromChain('waiting')).toBe('waiting')
    expect(statusFromSpec('in_progress')).toBe('running')
    expect(statusFromSpec('draft')).toBe('waiting')
  })

  it('reads other domain words and tolerates unknown ones', () => {
    expect(statusFromWord('Streaming')).toBe('running')
    expect(statusFromWord('needs-input')).toBe('needs_you')
    expect(statusFromWord('something new')).toBe('waiting')
    expect(isSettled('integrated')).toBe(true)
    expect(isSettled('running')).toBe(false)
  })
})
