/**
 * Format a job's stored `command` field for display.
 *
 * Jobs are queued with the canonical claude-shape command string
 * (`/specrails:implement #N`, `/sr:batch-implement`, …) regardless
 * of the project's provider — that's the form the wizard builds and
 * the form the queue-manager regex parses to extract ticket ids.
 *
 * Provider-native skill syntax is translated at render time. The stored value
 * never changes.
 *
 * Translation map:
 *   /specrails:<name>  →  $<name>
 *   /sr:<name>         →  $<name>   (alias used in some docs)
 * for Codex, and:
 *   /specrails:<name>  →  /skill:specrails-<name>
 *   /sr:<name>         →  /skill:specrails-<name>
 * for Kimi.
 *
 * For claude projects the command is returned verbatim.
 */
export function formatCommandForProvider(
  command: string,
  provider: string | null | undefined,
): string {
  if (provider === 'codex') {
    return command.replace(/(^|\s)\/(?:specrails|sr):([\w-]+)/g, '$1$$$2')
  }
  if (provider === 'kimi') {
    return command.replace(
      /(^|\s)\/(?:specrails|sr):([\w-]+)/g,
      '$1/skill:specrails-$2',
    )
  }
  return command
}
