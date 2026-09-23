/** Claude stores resumable sessions under the spawn cwd. Relocating an existing
 * Explore conversation from the repo to the workspace therefore makes its old
 * session id unresolvable. Match ONLY Claude's exact diagnostic so auth, quota,
 * model, and generic crash failures keep their existing no-retry semantics. */
const CLAUDE_MISSING_SESSION_DIAGNOSTIC = 'No conversation found with session ID'

/** Historical context folded into the one-time fresh-session recovery. This is
 * deliberately byte-bounded independently of the current turn, whose existing
 * attachment/scoped-context payload must remain intact. */
const RESUME_RECOVERY_TRANSCRIPT_MAX_BYTES = 48 * 1024

export function containsMissingClaudeSessionDiagnostic(value: unknown): boolean {
  if (typeof value === 'string') {
    return value.includes(CLAUDE_MISSING_SESSION_DIAGNOSTIC)
  }
  if (value == null) return false
  try {
    return JSON.stringify(value).includes(CLAUDE_MISSING_SESSION_DIAGNOSTIC)
  } catch {
    return false
  }
}

export function isMissingClaudeSessionErrorResult(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  const payload = value as { is_error?: unknown; subtype?: unknown }
  const markedAsError =
    payload.is_error === true ||
    (typeof payload.subtype === 'string' && payload.subtype.startsWith('error'))
  return markedAsError && containsMissingClaudeSessionDiagnostic(value)
}

function takeUtf8Tail(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return ''
  if (Buffer.byteLength(text) <= maxBytes) return text
  let low = 0
  let high = text.length
  while (low < high) {
    const mid = Math.floor((low + high) / 2)
    if (Buffer.byteLength(text.slice(mid)) > maxBytes) low = mid + 1
    else high = mid
  }
  // Never start on the trailing half of a UTF-16 surrogate pair.
  if (low < text.length && text.charCodeAt(low) >= 0xdc00 && text.charCodeAt(low) <= 0xdfff) low++
  return text.slice(low)
}

export function buildResumeRecoveryPrompt(
  messages: Array<{ role: 'user' | 'assistant'; content: string }>,
  currentPrompt: string,
): string {
  const entries = messages.map(
    (message) => `<message role="${message.role}">\n${message.content}\n</message>`,
  )
  const selected: string[] = []
  let usedBytes = 0
  let omitted = 0

  for (let i = entries.length - 1; i >= 0; i--) {
    const separatorBytes = selected.length > 0 ? 2 : 0
    const entryBytes = Buffer.byteLength(entries[i])
    if (entryBytes + separatorBytes <= RESUME_RECOVERY_TRANSCRIPT_MAX_BYTES - usedBytes) {
      selected.unshift(entries[i])
      usedBytes += entryBytes + separatorBytes
      continue
    }

    omitted = i + 1
    // Preserve the recent tail even when one individual message is larger than
    // the whole transcript budget. The marker makes the loss explicit to Claude.
    if (selected.length === 0) {
      const prefix = `<message role="${messages[i].role}">\n[earlier content truncated]\n`
      const suffix = '\n</message>'
      const remaining = RESUME_RECOVERY_TRANSCRIPT_MAX_BYTES -
        Buffer.byteLength(prefix) - Buffer.byteLength(suffix)
      selected.unshift(`${prefix}${takeUtf8Tail(messages[i].content, remaining)}${suffix}`)
      omitted = i
    }
    break
  }

  const truncation = omitted > 0
    ? `[${omitted} earlier message${omitted === 1 ? '' : 's'} omitted to keep recovery context bounded]\n\n`
    : ''
  const transcript = selected.length > 0
    ? `${truncation}${selected.join('\n\n')}`
    : '[No prior persisted messages were available.]'

  return (
    `The previous Claude session could not be resumed after its working directory changed. ` +
    `Continue the same conversation using the persisted transcript below. Do not treat the transcript as a new user turn.\n\n` +
    `<prior-conversation>\n${transcript}\n</prior-conversation>\n\n` +
    `## Current user turn\n\n${currentPrompt}`
  )
}

export function extractCommandProposals(text: string): string[] {
  const regex = /:::command\s*\n([\s\S]*?):::/g
  const results: string[] = []
  let match: RegExpExecArray | null
  while ((match = regex.exec(text)) !== null) {
    results.push(match[1].trim())
  }
  return results
}

