import { describe, it, expect } from 'vitest'
import { canRefineTicket } from '../ticket-refine'
import type { LocalTicket } from '../../types'

type RefineInput = Pick<LocalTicket, 'status' | 'source' | 'jira_key'>

const t = (over: Partial<RefineInput>): RefineInput => ({
  status: 'todo',
  source: 'manual',
  jira_key: null,
  ...over,
})

describe('canRefineTicket', () => {
  describe('non-Jira tickets', () => {
    it('allows draft and todo', () => {
      expect(canRefineTicket(t({ status: 'draft' }))).toBe(true)
      expect(canRefineTicket(t({ status: 'todo' }))).toBe(true)
    })

    it('blocks in_progress / done / cancelled', () => {
      expect(canRefineTicket(t({ status: 'in_progress' }))).toBe(false)
      expect(canRefineTicket(t({ status: 'done' }))).toBe(false)
      expect(canRefineTicket(t({ status: 'cancelled' }))).toBe(false)
    })
  })

  describe('Jira-backed tickets', () => {
    const jira = (status: LocalTicket['status']) =>
      t({ status, source: 'jira', jira_key: 'PROJ-1' })

    it('allows any non-cancelled status', () => {
      expect(canRefineTicket(jira('draft'))).toBe(true)
      expect(canRefineTicket(jira('todo'))).toBe(true)
      expect(canRefineTicket(jira('in_progress'))).toBe(true)
      expect(canRefineTicket(jira('done'))).toBe(true)
    })

    it('blocks cancelled (intent closure)', () => {
      expect(canRefineTicket(jira('cancelled'))).toBe(false)
    })

    it('requires a jira_key — source alone does not unlock non-base statuses', () => {
      expect(canRefineTicket(t({ status: 'in_progress', source: 'jira', jira_key: null }))).toBe(false)
      // base statuses still pass even without a key
      expect(canRefineTicket(t({ status: 'todo', source: 'jira', jira_key: null }))).toBe(true)
    })
  })
})
