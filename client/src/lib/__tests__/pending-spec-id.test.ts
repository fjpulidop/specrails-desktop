import { describe, it, expect } from 'vitest'
import { genPendingSpecId } from '../pending-spec-id'

// Mirrors the server guard SAFE_PENDING_ID (project-router-terminals.ts).
const SAFE_PENDING_ID = /^[A-Za-z0-9_-]{1,128}$/

describe('genPendingSpecId', () => {
  it('returns a non-empty, server-safe id (never the empty value that 400s capture)', () => {
    const id = genPendingSpecId()
    expect(id).toBeTruthy()
    expect(SAFE_PENDING_ID.test(id)).toBe(true)
  })

  it('returns distinct ids', () => {
    expect(genPendingSpecId()).not.toBe(genPendingSpecId())
  })
})
