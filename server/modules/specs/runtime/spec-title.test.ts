import { describe, it, expect } from 'vitest'
import { normalizeSpecTitle, SPEC_TITLE_MAX_CHARS, specDescriptionError, SPEC_DESCRIPTION_MAX_CHARS } from './spec-title'

describe('normalizeSpecTitle', () => {
  it('refuses a title made only of invisible format characters', () => {
    expect(normalizeSpecTitle('​​‮﻿')).toEqual({ ok: false, error: 'title is required' })
  })
  it('drops bidi overrides and zero-width characters inside a title', () => {
    expect(normalizeSpecTitle('Add​ a ‮comet‬')).toEqual({ ok: true, title: 'Add a comet' })
  })
  it('collapses newlines and whitespace runs to one space', () => {
    expect(normalizeSpecTitle('  Add\n\n  a\tflag  ')).toEqual({ ok: true, title: 'Add a flag' })
  })
  it('keeps emoji and non-Latin scripts', () => {
    expect(normalizeSpecTitle('🚀 Añadir 日本語')).toEqual({ ok: true, title: '🚀 Añadir 日本語' })
  })
  it('refuses an over-long title with an actionable message', () => {
    const r = normalizeSpecTitle('x'.repeat(SPEC_TITLE_MAX_CHARS + 1))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/description/)
    expect(normalizeSpecTitle('x'.repeat(SPEC_TITLE_MAX_CHARS)).ok).toBe(true)
  })
  it('uses the caller-provided empty message', () => {
    expect(normalizeSpecTitle('  ', 'title cannot be empty')).toEqual({ ok: false, error: 'title cannot be empty' })
  })
})

describe('specDescriptionError', () => {
  it('refuses a description past the limit with a pointer to attachments, and accepts absent or normal ones', () => {
    expect(specDescriptionError(undefined)).toBeNull()
    expect(specDescriptionError('x'.repeat(SPEC_DESCRIPTION_MAX_CHARS))).toBeNull()
    expect(specDescriptionError('x'.repeat(SPEC_DESCRIPTION_MAX_CHARS + 1))).toMatch(/attach/)
    expect(specDescriptionError(42)).toMatch(/string/)
  })
})
