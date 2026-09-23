/**
 * Parse and write the `## Acceptance Criteria` section of a ticket
 * description. Mirrors the server-side helper `formatDescriptionWithCriteria`
 * in `server/project-router.ts` so client and server agree on the shape.
 *
 * See openspec/changes/replace-ai-edit-with-continue-editing/design.md D3.
 */

const SECTION_RE = /\n*##\s*Acceptance Criteria\s*\n([\s\S]*?)(?=\n##\s|\n*$)/i

/**
 * Split a description body into the prose body and an extracted list of
 * acceptance criteria. The match is case-insensitive on the heading text but
 * requires exactly `##` (heading level 2).
 *
 * Recognised bullet styles: `- foo`, `* foo`, `+ foo`. Leading/trailing
 * whitespace on bullets is trimmed.
 */
export function parseAcceptanceCriteria(description: string): { body: string; criteria: string[] } {
  if (!description) return { body: '', criteria: [] }
  const m = SECTION_RE.exec(description)
  if (!m) return { body: description.replace(/\s+$/, ''), criteria: [] }
  const section = m[1]
  const before = description.slice(0, m.index)
  const after = description.slice(m.index + m[0].length)
  const body = `${before.replace(/\s+$/, '')}${after ? `\n\n${after.replace(/^\s+/, '')}` : ''}`
  const criteria = section
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*[-*+]\s+/, '').trim())
    .filter((line) => line.length > 0)
  return { body: body.replace(/\s+$/, ''), criteria }
}

/**
 * Format a description body + acceptanceCriteria array back into a single
 * markdown string with a `## Acceptance Criteria` section. Symmetric to
 * `parseAcceptanceCriteria` so a parse → format round-trip is stable.
 */
export function formatWithCriteria(body: string, criteria: string[]): string {
  const trimmed = body.replace(/\s+$/, '')
  if (criteria.length === 0) return trimmed
  const section = `## Acceptance Criteria\n\n${criteria.map((c) => `- ${c}`).join('\n')}`
  if (trimmed === '') return section
  return `${trimmed}\n\n${section}`
}
