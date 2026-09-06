/** Claude's authoritative background roster. null means "no valid update",
 * whereas [] explicitly confirms that the provider has no live workers. */
export function readClaudeBackgroundTasks(frame: Record<string, unknown> | null): string[] | null {
  if (frame?.type !== 'system' || frame.subtype !== 'background_tasks_changed' || !Array.isArray(frame.tasks)) return null
  // Claude marks live-update watchers and skip-transcript tasks as ambient:
  // they are not foreground activity and need not finish for a step to end.
  // Only the explicit boolean opts out; older/malformed entries still block.
  return frame.tasks.filter((task: unknown) => (task as { ambient?: unknown } | null)?.ambient !== true).map((task: unknown) => {
    const item = (task ?? {}) as { task_id?: unknown; description?: unknown }
    const id = typeof item.task_id === 'string' ? item.task_id : ''
    const description = typeof item.description === 'string' ? item.description.trim() : ''
    return (description ? `${id ? `${id}: ` : ''}${description}` : id || 'task').slice(0, 500)
  })
}
