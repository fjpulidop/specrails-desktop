/**
 * "/specrails:implement #15" -> "Implement · #15 Title" once the spec title is
 * known. Falls back to the verbatim command, which stays in the row tooltip.
 */
export function humaniseCommand(command: string, titles: Record<number, string> | undefined): string | null {
  if (!titles) return null
  // Slash/skill commands ("/specrails:implement #15") and loop launches ("loop: Implement #15").
  const verb = /^\s*[/$](?:specrails:|sr:)?([a-z][\w-]*)/i.exec(command)?.[1]
    ?? /^\s*loop\s*:\s*(.+?)\s*(?:#\d+.*)?$/i.exec(command)?.[1]
  const id = /#(\d+)/.exec(command)?.[1]
  const title = id ? titles[Number(id)] : undefined
  if (!verb || !id || !title) return null
  const label = verb.replace(/-/g, ' ')
  return `${label.charAt(0).toUpperCase()}${label.slice(1)} · #${id} ${title}`
}

/** Spec titles by ticket id from a job's `tickets` array. */
export function ticketTitlesOf(tickets: Array<{ id: number; title: string | null }> | undefined): Record<number, string> | undefined {
  if (!tickets?.length) return undefined
  const out: Record<number, string> = {}
  for (const ticket of tickets) if (ticket.title) out[ticket.id] = ticket.title
  return out
}
