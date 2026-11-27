/** Keeps the live conversations, the open one and those `keep` names, preserving order. */
export function filterActiveConversations<T extends { id: string }>(
  conversations: readonly T[],
  liveIds: ReadonlySet<string>,
  activeId: string | null | undefined,
  keep?: (conversation: T) => boolean,
): T[] {
  return conversations.filter((c) => liveIds.has(c.id) || c.id === activeId || keep?.(c) === true)
}
