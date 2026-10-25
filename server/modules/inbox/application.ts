import { compareInboxItems, MAX_ITEMS_PER_PROJECT, type InboxItem, type InboxSnapshot } from './domain'
import type { ProjectInboxSource } from './ports'

/**
 * Project the inbox: ask each project's own source, isolate failures (one
 * broken project never hides the others), cap each project and order newest
 * first. Nothing is cached; every call reads current state.
 */
export function collectInbox(sources: readonly ProjectInboxSource[], now: () => Date = () => new Date()): InboxSnapshot {
  const items: InboxItem[] = []
  const projects: InboxSnapshot['projects'] = []
  for (const source of sources) {
    let own: InboxItem[] = []
    try {
      own = source.collect()
    } catch (err) {
      console.warn(`[inbox] ${source.projectId} unavailable (skipped):`, err instanceof Error ? err.message : err)
    }
    // A source can only speak for its own project.
    const scoped = own.filter((item) => item.projectId === source.projectId).sort(compareInboxItems).slice(0, MAX_ITEMS_PER_PROJECT)
    items.push(...scoped)
    projects.push({ projectId: source.projectId, projectName: source.projectName, count: scoped.length })
  }
  items.sort(compareInboxItems)
  return { items, projects, generatedAt: now().toISOString() }
}
