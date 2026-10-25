import type { InboxItem } from './domain'

/**
 * One project's attention sources, bound to that project's own state. The
 * collector never receives anything shared between projects.
 */
export interface ProjectInboxSource {
  projectId: string
  projectName: string
  /** Everything in this project that currently waits for the person. */
  collect(): InboxItem[]
}
