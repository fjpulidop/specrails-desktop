import type { AgentContextChip } from './agent-context-palette'
import { composerDrafts, composerReferenceDrafts, writeComposerDraft } from './agent-composer-drafts'

export const SPEC_DRAG_TYPE = 'application/x-specrails-mission-spec'

/** A drop belongs to the exact mission and project it came from. */
export function readSpecDrag(raw: string, draftKey: string, projectId: string | null): AgentContextChip | null {
  try {
    const payload = JSON.parse(raw)
    const chip = payload?.chip
    if (!projectId || payload?.draftKey !== draftKey || chip?.projectId !== projectId
      || chip?.kind !== 'spec' || typeof chip.id !== 'string' || !/^\d+$/.test(chip.id)
      || typeof chip.label !== 'string' || !chip.label.trim() || chip.label.length > 2000
      || chip.token !== `@${chip.label}`) return null
    return { kind: 'spec', id: chip.id, label: chip.label, token: chip.token, projectId,
      detail: `#${chip.id}`, status: typeof chip.status === 'string' ? chip.status : null,
      metadata: { ticketId: Number(chip.id) } }
  } catch { return null }
}

/** Insert a reference into the existing draft, preserving other reference spans. */
export function insertDroppedSpec(draftKey: string, chip: AgentContextChip, caret: number): number {
  const text = composerDrafts.get(draftKey) ?? ''
  const references = composerReferenceDrafts.get(draftKey) ?? []
  if (references.some(ref => ref.chip.kind === 'spec' && ref.chip.id === chip.id && ref.chip.projectId === chip.projectId)) return caret
  let start = Math.max(0, Math.min(caret, text.length))
  const containing = references.find(ref => start > ref.start && start < ref.end)
  if (containing) start = containing.end
  const prefix = start > 0 && !/\s/.test(text[start - 1]) ? ' ' : ''
  const insertion = `${prefix}${chip.token} `
  const tokenStart = start + prefix.length
  writeComposerDraft(draftKey, text.slice(0, start) + insertion + text.slice(start), [
    ...references.map(ref => ref.start >= start ? { ...ref, start: ref.start + insertion.length, end: ref.end + insertion.length } : ref),
    { key: crypto.randomUUID(), start: tokenStart, end: tokenStart + chip.token.length, chip },
  ].sort((a, b) => a.start - b.start))
  return start + insertion.length
}
