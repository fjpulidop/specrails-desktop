import type { TicketPriority } from '../../../types'

/** Badge tone per spec priority. Canon shared by every priority chip:
 *  high reads as caution (warning), medium as informational (running). */
export type PriorityTone = 'destructive' | 'warning' | 'running' | 'outline'

export const PRIORITY_TONE: Record<TicketPriority, PriorityTone> = {
  critical: 'destructive',
  high: 'warning',
  medium: 'running',
  low: 'outline',
}
