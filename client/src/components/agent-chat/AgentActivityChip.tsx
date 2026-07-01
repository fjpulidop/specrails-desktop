import { useTranslation } from 'react-i18next'
import { motion, AnimatePresence } from 'motion/react'
import { Loader2 } from 'lucide-react'

/**
 * Abbreviated, synthetic label for the current tool activity. MCP calls collapse
 * to `MCP · <domain>`; built-ins map to a short verb; anything else shows raw.
 */
export function toolChipLabel(tool: string): string {
  if (tool.startsWith('mcp__')) {
    const last = tool.split('__').pop()?.replace(/^specrails_/, '') ?? ''
    return last ? `MCP · ${last}` : 'MCP Tool'
  }
  const map: Record<string, string> = {
    Bash: 'Terminal',
    Read: 'Reading',
    Grep: 'Searching',
    Glob: 'Searching',
    Write: 'Editing',
    Edit: 'Editing',
    NotebookEdit: 'Editing',
    WebFetch: 'Web',
    WebSearch: 'Web',
    Task: 'Agent',
  }
  return map[tool] ?? tool
}

/**
 * A single, compact activity chip that mutates as tool calls stream in (industry
 * pattern) — replaces the stacked per-tool log. Shows "Thinking…" until the first
 * tool fires, then crossfades to the latest activity label.
 */
/** Tool names that carry no useful signal → show "Thinking…" instead. */
const NOISE = new Set(['<unnamed>', '<missing>', ''])

export function AgentActivityChip({ tool }: { tool: string | null }) {
  const { t } = useTranslation('agent')
  const label = tool && !NOISE.has(tool) ? toolChipLabel(tool) : t('thinking')

  return (
    <div className="inline-flex items-center gap-2 rounded-full border border-border/50 bg-surface/60 px-3 py-1 text-xs font-medium text-foreground/80">
      <Loader2 className="h-3 w-3 animate-spin text-accent-info" />
      <AnimatePresence mode="wait" initial={false}>
        <motion.span
          key={label}
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -4 }}
          transition={{ duration: 0.16, ease: 'easeOut' }}
        >
          {label}
        </motion.span>
      </AnimatePresence>
    </div>
  )
}
