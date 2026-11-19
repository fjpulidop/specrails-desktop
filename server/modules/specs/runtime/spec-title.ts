/**
 * Spec title normalization shared by spec create and edit.
 *
 * A title becomes a board card label, a branch and PR name and a prompt
 * heading, so it must be visible, single-line text. Invisible format
 * characters (zero-width spaces, bidi overrides, BOMs) are dropped, any
 * whitespace run (including newlines) collapses to one space, and a title that
 * is empty after that, or longer than {@link SPEC_TITLE_MAX_CHARS}, is refused
 * with a message that says where the rest belongs.
 */
export const SPEC_TITLE_MAX_CHARS = 300

export type SpecTitleResult = { ok: true; title: string } | { ok: false; error: string }

export function normalizeSpecTitle(raw: unknown, emptyError = 'title is required'): SpecTitleResult {
  if (typeof raw !== 'string') return { ok: false, error: emptyError }
  const title = raw.replace(/\p{Cf}/gu, '').replace(/\s+/gu, ' ').trim()
  if (!title) return { ok: false, error: emptyError }
  if ([...title].length > SPEC_TITLE_MAX_CHARS) {
    return { ok: false, error: `title must be at most ${SPEC_TITLE_MAX_CHARS} characters; put the details in the description` }
  }
  return { ok: true, title }
}

/**
 * A spec description is read by every planning and review turn, so its size is
 * spend. 200,000 characters is far beyond any real spec (a whole-product spec
 * of 60 requirements is ~17,000); larger pasted material belongs in an
 * attachment, which turns read only when they need it.
 */
export const SPEC_DESCRIPTION_MAX_CHARS = 200_000

export function specDescriptionError(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null
  if (typeof raw !== 'string') return 'description must be a string'
  return raw.length > SPEC_DESCRIPTION_MAX_CHARS ? `description must be at most ${SPEC_DESCRIPTION_MAX_CHARS} characters; attach longer material to the spec as a file` : null
}
