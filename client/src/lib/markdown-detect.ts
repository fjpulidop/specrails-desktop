/**
 * Detects lines that contain markdown formatting.
 * Used by LogViewer to decide between plain text and rich rendering.
 */
export function hasMarkdownSyntax(line: string): boolean {
  const trimmed = line.trimStart()
  if (/^#{1,6}\s/.test(trimmed)) return true
  if (/^[-*+]\s/.test(trimmed)) return true
  if (/^\d+\.\s/.test(trimmed)) return true
  if (/^\|.+\|/.test(trimmed)) return true
  if (trimmed.startsWith('```')) return true
  if (trimmed.startsWith('> ')) return true
  if (/\*\*[^*]+\*\*/.test(line)) return true
  if (/`[^`]+`/.test(line)) return true
  if (/\[.+\]\(.+\)/.test(line)) return true
  if (/^(-{3,}|_{3,}|\*{3,})$/.test(trimmed)) return true
  if (/^- \[[ x]\]\s/.test(trimmed)) return true
  return false
}
