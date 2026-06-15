// Shared stream-frame → human-readable display-text extraction.
//
// Extracted from queue-manager so the interactive-job session transport can
// render the SAME log lines QueueManager's one-shot spawn does, without a
// circular import between the two modules.

/**
 * Map a parsed provider stream-json frame to the single display line the Job
 * Detail log shows (or null when the frame carries no user-facing text).
 * Handles both Claude `--output-format stream-json` and Codex `exec --json`.
 */
export function extractDisplayText(event: Record<string, unknown>): string | null {
  const type = event.type as string
  // ── Claude `--output-format stream-json` ───────────────────────────────
  if (type === 'assistant') {
    const content = event.message as { content?: Array<{ type: string; text?: string }> } | undefined
    const texts = (content?.content ?? [])
      .filter((c) => c.type === 'text')
      .map((c) => c.text ?? '')
    return texts.join('') || null
  }
  if (type === 'tool_use') {
    const name = (event as Record<string, unknown>).name as string
    const input = JSON.stringify((event as Record<string, unknown>).input ?? {})
    return `[tool: ${name}] ${input.slice(0, 120)}`
  }
  if (type === 'tool_result' || type === 'system_prompt' || type === 'user' || type === 'system' || type === 'result') {
    return null
  }
  // ── Codex `exec --json` event types ───────────────────────────────────
  // Codex shape differs from claude: items are nested under `item` with a
  // discriminator at `item.type`. Without explicit handling the Job Detail
  // log shows only the spawn preamble and exit notice — exactly the
  // "2 / 2 lines" symptom that masks 200k+ tokens of real work.
  if (type === 'item.completed' || type === 'item.started') {
    const item = event.item as Record<string, unknown> | undefined
    if (!item) return null
    const itemType = item.type as string | undefined
    if (itemType === 'agent_message') {
      const text = (item.text as string | undefined)?.trim()
      return text && text.length > 0 ? text : null
    }
    if (itemType === 'command_execution') {
      // Only surface the completed line so the log isn't doubled with the
      // matching `item.started` placeholder.
      if (type !== 'item.completed') return null
      const cmd = (item.command as string | undefined) ?? ''
      const exitCode = item.exit_code as number | null | undefined
      const exitStr = typeof exitCode === 'number' ? ` → exit ${exitCode}` : ''
      return `[exec]${exitStr} ${cmd.slice(0, 200)}`
    }
    if (itemType === 'agent_reasoning') {
      const text = (item.text as string | undefined)?.trim()
      return text && text.length > 0 ? `[reasoning] ${text.slice(0, 200)}` : null
    }
    return null
  }
  if (type === 'thread.started' || type === 'turn.started' || type === 'turn.completed') {
    return null
  }
  return null
}
