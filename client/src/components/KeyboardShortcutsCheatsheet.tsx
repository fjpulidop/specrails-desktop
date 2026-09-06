import { useTranslation, Trans } from 'react-i18next'
import { SHORTCUTS, type Shortcut } from '../hooks/useKeyboardShortcuts'
import { keyboardLabel } from '../lib/keyboard-label'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from './ui/dialog'

interface KeyboardShortcutsCheatsheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

const CATEGORY_LABEL_KEYS: Record<Shortcut['category'], string> = {
  general: 'shortcuts.categories.general',
  navigation: 'shortcuts.categories.navigation',
  actions: 'shortcuts.categories.actions',
}

const CATEGORY_ORDER: Shortcut['category'][] = ['general', 'navigation', 'actions']

function Kbd({ children }: { children: string }) {
  return (
    <kbd className="inline-flex items-center justify-center min-w-[1.5rem] h-6 px-1.5 rounded border border-border/50 bg-card/80 font-mono text-xs text-foreground">
      {children}
    </kbd>
  )
}

function ShortcutRow({ shortcut }: { shortcut: Shortcut }) {
  const { t } = useTranslation('commands')
  const keys = keyboardLabel(shortcut.keys).split(' ')
  return (
    <div className="flex items-center justify-between py-1.5">
      <span className="text-sm text-muted-foreground">{t(shortcut.descriptionKey)}</span>
      <div className="flex items-center gap-1 ml-4 shrink-0">
        {keys.map((k, i) => (
          <Kbd key={i}>{k}</Kbd>
        ))}
      </div>
    </div>
  )
}

export function KeyboardShortcutsCheatsheet({ open, onOpenChange }: KeyboardShortcutsCheatsheetProps) {
  const { t } = useTranslation('commands')
  const grouped = CATEGORY_ORDER.map((cat) => ({
    category: cat,
    label: t(CATEGORY_LABEL_KEYS[cat]),
    shortcuts: SHORTCUTS.filter((s) => s.category === cat),
  })).filter((g) => g.shortcuts.length > 0)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent movableResizable className="max-w-md" data-testid="shortcuts-cheatsheet">
        <DialogHeader>
          <DialogTitle>{t('shortcuts.title')}</DialogTitle>
          <DialogDescription>
            <Trans i18nKey="shortcuts.subtitle" ns="commands">
              Press <Kbd>?</Kbd> anywhere to toggle this panel
            </Trans>
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 mt-2">
          {grouped.map((group) => (
            <div key={group.category}>
              <h3 className="text-xs font-semibold uppercase tracking-wider text-accent-primary mb-2">
                {group.label}
              </h3>
              <div className="divide-y divide-border/30">
                {group.shortcuts.map((s) => (
                  <ShortcutRow key={s.keys} shortcut={s} />
                ))}
              </div>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  )
}
