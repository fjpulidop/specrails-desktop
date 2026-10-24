/**
 * "/specrails:implement #15" -> "Implement · #15 Title" once the spec title is
 * known. Falls back to the verbatim command, which stays in the row tooltip.
 */
export function humaniseCommand(command: string, titles: Record<number, string> | undefined, opts?: { omitTitle?: boolean }): string | null {
  if (!titles) return null
  // Slash/skill commands ("/specrails:implement #15") and loop launches ("loop: Implement #15").
  const verb = /^\s*[/$](?:specrails:|sr:)?([a-z][\w-]*)/i.exec(command)?.[1]
    ?? /^\s*loop\s*:\s*(.+?)\s*(?:#\d+.*)?$/i.exec(command)?.[1]
  const id = /#(\d+)/.exec(command)?.[1]
  const title = id ? titles[Number(id)] : undefined
  if (!verb || !id || !title) return null
  const label = verb.replace(/-/g, ' ')
  const name = `${label.charAt(0).toUpperCase()}${label.slice(1)}`
  // The ticket header already shows "#id Title": only name the loop/mode.
  return opts?.omitTitle ? name : `${name} · #${id} ${title}`
}

/** Spec titles by ticket id from a job's `tickets` array. */
export function ticketTitlesOf(tickets: Array<{ id: number; title: string | null }> | undefined): Record<number, string> | undefined {
  if (!tickets?.length) return undefined
  const out: Record<number, string> = {}
  for (const ticket of tickets) if (ticket.title) out[ticket.id] = ticket.title
  return out
}

/**
 * Breadcrumb label: "Implement · #15" (no title, so it never competes with the
 * ticket header). Null when the command carries no recognisable verb/ticket.
 */
export function humaniseJobCrumb(command: string): string | null {
  const verb = /^\s*[/$](?:specrails:|sr:)?([a-z][\w-]*)/i.exec(command)?.[1]
    ?? /^\s*loop\s*:\s*(.+?)\s*(?:#\d+.*)?$/i.exec(command)?.[1]
  if (!verb) return null
  const id = /#(\d+)/.exec(command)?.[1]
  const label = verb.replace(/-/g, ' ')
  const name = `${label.charAt(0).toUpperCase()}${label.slice(1)}`
  return id ? `${name} · #${id}` : name
}
