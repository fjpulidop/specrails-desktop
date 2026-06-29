import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { Check, Copy, RefreshCw, ExternalLink, ClipboardList } from 'lucide-react'
import { API_ORIGIN } from '../lib/origin'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from './ui/dialog'
import { Button } from './ui/button'
import { cn } from '../lib/utils'
import type { Platform, SetupPrerequisitesStatus } from '../hooks/usePrerequisites'

interface Props {
  open: boolean
  onClose: () => void
  status: SetupPrerequisitesStatus | null
  onRecheck: () => void
  isRechecking?: boolean
}

interface PlatformInstructions {
  title: string
  intro?: string
  commands: { label: string; command: string }[]
  links: { label: string; url: string }[]
  note?: string
}

// Built per-render from the active language. OS titles ("macOS", "Windows",
// "Linux") are proper names and intentionally untranslated.
function getInstructions(t: TFunction): Record<Platform, PlatformInstructions> {
  return {
    darwin: {
      title: 'macOS',
      intro: t('setup:instructions.darwin.intro'),
      commands: [
        { label: t('setup:instructions.darwin.installNodeGit'), command: 'brew install node git' },
      ],
      links: [
        { label: t('setup:instructions.links.nodeOfficial'), url: 'https://nodejs.org/en/download' },
        { label: t('setup:instructions.links.gitOfficial'), url: 'https://git-scm.com/downloads' },
        { label: 'Homebrew', url: 'https://brew.sh' },
      ],
    },
    win32: {
      title: 'Windows',
      intro: t('setup:instructions.win32.intro'),
      commands: [
        { label: t('setup:instructions.win32.installNode'), command: 'winget install OpenJS.NodeJS.LTS' },
        { label: t('setup:instructions.win32.installGit'), command: 'winget install Git.Git' },
      ],
      links: [
        { label: t('setup:instructions.links.nodeOfficial'), url: 'https://nodejs.org/en/download' },
        { label: t('setup:instructions.links.gitWindows'), url: 'https://git-scm.com/download/win' },
      ],
      note: t('setup:instructions.win32.note'),
    },
    linux: {
      title: 'Linux',
      intro: t('setup:instructions.linux.intro'),
      commands: [
        { label: t('setup:instructions.linux.debian'), command: 'sudo apt install -y nodejs npm git' },
        { label: t('setup:instructions.linux.fedora'), command: 'sudo dnf install -y nodejs npm git' },
      ],
      links: [
        { label: t('setup:instructions.links.nodeOfficial'), url: 'https://nodejs.org/en/download' },
        { label: t('setup:instructions.links.gitOfficial'), url: 'https://git-scm.com/downloads' },
      ],
    },
  }
}

const ALL_PLATFORMS: Platform[] = ['darwin', 'win32', 'linux']

async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // fall through to fallback
  }
  try {
    const textarea = document.createElement('textarea')
    textarea.value = text
    textarea.setAttribute('readonly', '')
    textarea.style.position = 'fixed'
    textarea.style.opacity = '0'
    document.body.appendChild(textarea)
    textarea.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(textarea)
    return ok
  } catch {
    return false
  }
}

function CopyButton({ command }: { command: string }) {
  const { t } = useTranslation('setup')
  const [copied, setCopied] = useState(false)

  const handleCopy = async () => {
    const ok = await copyToClipboard(command)
    if (ok) {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    }
  }

  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      onClick={handleCopy}
      className="h-7 px-2 gap-1.5 text-[11px]"
      data-testid="install-copy-button"
    >
      {copied ? (
        <>
          <Check className="w-3 h-3" />
          {t('common:actions.copied')}
        </>
      ) : (
        <>
          <Copy className="w-3 h-3" />
          {t('common:actions.copy')}
        </>
      )}
    </Button>
  )
}

function PlatformSection({ platform, primary }: { platform: Platform; primary: boolean }) {
  const { t } = useTranslation('setup')
  const instr = getInstructions(t)[platform]
  return (
    <section
      data-testid={`install-section-${platform}`}
      className={cn(
        'rounded-lg border px-3 py-3',
        primary ? 'border-border/40 bg-background/40' : 'border-border/20 bg-background/20',
      )}
    >
      <h3 className="text-sm font-semibold text-foreground">{instr.title}</h3>
      {instr.intro && (
        <p className="mt-1 text-[11px] text-muted-foreground">{instr.intro}</p>
      )}
      <div className="mt-2 space-y-2">
        {instr.commands.map((c) => (
          <div key={c.command} className="rounded-md border border-border/30 bg-background/60 px-2 py-2">
            <p className="text-[11px] text-muted-foreground mb-1">{c.label}</p>
            <div className="flex items-center justify-between gap-2">
              <code className="text-xs text-foreground font-mono break-all">{c.command}</code>
              <CopyButton command={c.command} />
            </div>
          </div>
        ))}
      </div>
      {instr.links.length > 0 && (
        <ul className="mt-2 flex flex-wrap gap-x-3 gap-y-1">
          {instr.links.map((link) => (
            <li key={link.url}>
              <a
                href={link.url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-[11px] text-accent-info hover:underline"
              >
                {link.label}
                <ExternalLink className="w-3 h-3" />
              </a>
            </li>
          ))}
        </ul>
      )}
      {instr.note && (
        <p className="mt-2 text-[11px] text-accent-highlight">{instr.note}</p>
      )}
    </section>
  )
}

function CopyDiagnosticsButton() {
  const { t } = useTranslation('setup')
  const [state, setState] = useState<'idle' | 'copying' | 'copied' | 'error'>('idle')

  const onClick = async () => {
    setState('copying')
    try {
      const res = await fetch(`${API_ORIGIN}/api/setup-prerequisites?diagnostic=1`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = await res.json()
      await navigator.clipboard.writeText(JSON.stringify(json, null, 2))
      setState('copied')
      setTimeout(() => setState('idle'), 1800)
    } catch {
      setState('error')
      setTimeout(() => setState('idle'), 2400)
    }
  }

  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      onClick={onClick}
      disabled={state === 'copying'}
      className="gap-1.5 text-[11px]"
      data-testid="copy-diagnostics-button"
    >
      {state === 'copied' ? (
        <Check className="w-3 h-3 text-accent-success" />
      ) : (
        <ClipboardList className="w-3 h-3" />
      )}
      {state === 'copied'
        ? t('instructions.diagnostics.copied')
        : state === 'error'
          ? t('instructions.diagnostics.failed')
          : t('instructions.diagnostics.copy')}
    </Button>
  )
}

export function InstallInstructionsModal({ open, onClose, status, onRecheck, isRechecking }: Props) {
  const { t } = useTranslation('setup')
  const [showOthers, setShowOthers] = useState(false)
  const platform: Platform = status?.platform ?? 'darwin'
  const others = ALL_PLATFORMS.filter((p) => p !== platform)

  // Defence-in-depth: if the missing tool has error='corrupted-bundle', it is a
  // bundled tool that cannot be installed separately. Render a simplified error
  // panel instead of OS install instructions.
  const hasCorruptedBundle = status?.missingRequired?.some(
    (item) => item.error === 'corrupted-bundle',
  ) ?? false

  if (hasCorruptedBundle) {
    return (
      <Dialog open={open} onOpenChange={(o) => { if (!o) onClose() }}>
        <DialogContent movableResizable className="max-w-xl" data-testid="install-modal-corrupted-bundle">
          <DialogHeader>
            <DialogTitle>{t('instructions.corrupted.title')}</DialogTitle>
            <DialogDescription>
              {t('instructions.corrupted.description')}
            </DialogDescription>
          </DialogHeader>
          <p className="text-sm text-foreground">
            {t('instructions.corrupted.body')}
          </p>
          <div className="flex justify-end mt-2">
            <Button type="button" variant="ghost" size="sm" onClick={onClose} data-testid="install-corrupted-close-button">
              {t('common:actions.close')}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    )
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent movableResizable className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{t('instructions.title')}</DialogTitle>
          <DialogDescription>
            {t('instructions.description')}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <PlatformSection platform={platform} primary />

          <button
            type="button"
            onClick={() => setShowOthers((v) => !v)}
            className="text-[11px] text-muted-foreground hover:text-foreground underline-offset-2 hover:underline"
            data-testid="install-toggle-others"
          >
            {showOthers ? t('instructions.hideOtherPlatforms') : t('instructions.showOtherPlatforms')}
          </button>

          {showOthers && (
            <div className="space-y-3">
              {others.map((p) => (
                <PlatformSection key={p} platform={p} primary={false} />
              ))}
            </div>
          )}
        </div>

        <div className="flex items-center justify-between gap-2 mt-2">
          <CopyDiagnosticsButton />
          <div className="flex items-center gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={onClose}>
              {t('common:actions.close')}
            </Button>
            <Button
              type="button"
              variant="default"
              size="sm"
              onClick={onRecheck}
              disabled={isRechecking}
              className="gap-1.5"
              data-testid="install-recheck-button"
            >
              <RefreshCw className={cn('w-3 h-3', isRechecking && 'animate-spin')} />
              {t('instructions.recheck')}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
