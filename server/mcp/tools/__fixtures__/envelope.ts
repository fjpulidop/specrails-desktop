// Test-only readers for the MCP response envelope (server/mcp/tools/envelope.ts).
// Excluded from coverage as a shared fixture.
interface ResultLike { content?: Array<{ type: string; text?: string }>; structuredContent?: unknown; isError?: boolean }

/** The first text block of a tool result. */
export function resultText(result: ResultLike): string {
  return result.content?.find((block) => block.type === 'text')?.text ?? ''
}

/** The envelope: structuredContent when present, else the JSON text. */
export function envelopeOf(result: ResultLike): Record<string, any> {
  if (result.structuredContent && typeof result.structuredContent === 'object') return result.structuredContent as Record<string, any>
  return JSON.parse(resultText(result)) as Record<string, any>
}

/** The tool payload (`data`) of a successful call; throws with the error message otherwise. */
export function payloadOf<T = any>(result: ResultLike): T {
  const envelope = envelopeOf(result)
  if (envelope.ok === false) throw new Error(String(envelope.error?.message ?? 'tool error'))
  return envelope.data as T
}

/** The error message of a failed call ('' when it succeeded). */
export function errorMessage(result: ResultLike): string {
  try {
    const envelope = envelopeOf(result)
    return envelope.ok === false ? String(envelope.error?.message ?? '') : ''
  } catch {
    return resultText(result)
  }
}
