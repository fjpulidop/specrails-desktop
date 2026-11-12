/** Keeps the live conversations plus the open one, preserving order. */
export function filterActiveConversations<T extends { id: string }>(
  conversations: readonly T[],
  liveIds: ReadonlySet<string>,
  activeId: string | null | undefined,
): T[] {
  return conversations.filter((c) => liveIds.has(c.id) || c.id === activeId)
}
