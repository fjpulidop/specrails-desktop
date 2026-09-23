/**
 * Canon visual mappings for loop node kinds — mirrors LoopBuilderPage's
 * NODE_ICON / NODE_ACCENT (deliberately NOT imported from the page: that would
 * pull @xyflow/react into the job-detail chunk).
 */

import { Brain, Terminal, GitBranch, Play, Flag, Square, type LucideIcon } from 'lucide-react'

export const LOOP_NODE_ICON: Record<string, LucideIcon> = {
  start: Play,
  'ai-step': Brain,
  shell: Terminal,
  decider: GitBranch,
  condition: GitBranch,
  end: Flag,
}

export const LOOP_NODE_FALLBACK_ICON: LucideIcon = Square

/** Icon/text accent per kind (same accents the builder uses on node borders). */
export const LOOP_NODE_TEXT_ACCENT: Record<string, string> = {
  start: 'text-accent-success',
  'ai-step': 'text-accent-primary',
  shell: 'text-accent-warning',
  decider: 'text-accent-highlight',
  condition: 'text-accent-info',
  end: 'text-accent-secondary',
}

export const LOOP_NODE_BORDER_ACCENT: Record<string, string> = {
  start: 'border-accent-success/60',
  'ai-step': 'border-accent-primary/60',
  shell: 'border-accent-warning/60',
  decider: 'border-accent-highlight/60',
  condition: 'border-accent-info/60',
  end: 'border-accent-secondary/60',
}

export function loopNodeIcon(kind: string): LucideIcon {
  return LOOP_NODE_ICON[kind] ?? LOOP_NODE_FALLBACK_ICON
}
