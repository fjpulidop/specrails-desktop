import { describe, it, expect, beforeEach } from 'vitest'
import { markServerAssignmentsAdopted, reconcileIdleTickets, sameTicketIds, serverAssignmentsAdopted } from '../board-rails'

const base = { before: undefined, pending: false, legacy: false, claimedElsewhere: new Set<number>() }

describe('reconcileIdleTickets: the server owns an idle rail\'s specs', () => {
  it('adopts the server assignment on a fresh client (nothing local)', () => {
    expect(reconcileIdleTickets({ ...base, local: [], server: [1, 2] })).toEqual({ ticketIds: [1, 2], push: false })
  })

  it('replaces a stale local assignment once the board reconciled before', () => {
    expect(reconcileIdleTickets({ ...base, local: [5], server: [] }).ticketIds).toEqual([])
    expect(reconcileIdleTickets({ ...base, local: [5], server: [6, 5] }).ticketIds).toEqual([6, 5])
  })

  it('keeps the local array identity when both agree (no re-render)', () => {
    const local = [3, 4]
    expect(reconcileIdleTickets({ ...base, local, server: [3, 4] }).ticketIds).toBe(local)
  })

  it('keeps a rail the server does not list', () => {
    const local = [9]
    expect(reconcileIdleTickets({ ...base, local, server: undefined })).toEqual({ ticketIds: local, push: false })
  })

  it('keeps a move made while the request was in flight, or still being written', () => {
    expect(reconcileIdleTickets({ ...base, local: [2], before: [], server: [] }).ticketIds).toEqual([2])
    expect(reconcileIdleTickets({ ...base, local: [2], before: [2], server: [], pending: true }).ticketIds).toEqual([2])
  })

  it('a board that never reconciled keeps (and writes up) what it saved only locally', () => {
    expect(reconcileIdleTickets({ ...base, legacy: true, local: [7], server: [] })).toEqual({ ticketIds: [7], push: true })
  })

  it('never keeps a legacy local assignment the server already placed elsewhere, nor one over a server assignment', () => {
    expect(reconcileIdleTickets({ ...base, legacy: true, local: [7], server: [], claimedElsewhere: new Set([7]) })).toEqual({ ticketIds: [], push: false })
    expect(reconcileIdleTickets({ ...base, legacy: true, local: [7], server: [8] })).toEqual({ ticketIds: [8], push: false })
  })
})

describe('server assignment flag', () => {
  beforeEach(() => localStorage.clear())
  it('is per project and survives reloads', () => {
    expect(serverAssignmentsAdopted('p1')).toBe(false)
    markServerAssignmentsAdopted('p1')
    expect(serverAssignmentsAdopted('p1')).toBe(true)
    expect(serverAssignmentsAdopted('p2')).toBe(false)
    expect(serverAssignmentsAdopted(null)).toBe(false)
  })

  it('sameTicketIds compares order too', () => {
    expect(sameTicketIds([1, 2], [1, 2])).toBe(true)
    expect(sameTicketIds([1, 2], [2, 1])).toBe(false)
  })
})
