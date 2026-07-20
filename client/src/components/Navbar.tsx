import { useEffect, useState } from 'react'
import { NavLink } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Settings, BookOpen, LayoutDashboard, BarChart3 } from 'lucide-react'
import { cn } from '../lib/utils'
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip'
import type { ProviderId } from '../lib/provider-capabilities'

interface CLIStatus {
  provider: ProviderId | null
  version: string | null
}

function CLIBadge() {
  const { t } = useTranslation('nav')
  const [status, setStatus] = useState<CLIStatus | null>(null)

  useEffect(() => {
    fetch('/api/cli-status')
      .then((r) => r.json() as Promise<CLIStatus>)
      .then(setStatus)
      .catch(() => setStatus({ provider: null, version: null }))
  }, [])

  if (!status) return null

  const label =
    status.provider === 'claude'
      ? `Claude Code${status.version ? ` v${status.version}` : ''}`
      : status.provider === 'codex'
        ? `Codex CLI${status.version ? ` v${status.version}` : ''}`
        : status.provider === 'gemini'
          ? `Gemini CLI${status.version ? ` v${status.version}` : ''}`
          : status.provider === 'kimi'
            ? `Kimi Code${status.version ? ` v${status.version}` : ''}`
          : t('navbar.noCli')

  const badgeClass =
    status.provider === 'claude'
      ? 'bg-blue-500/15 text-blue-400 aurora-light:text-accent-info border-blue-500/30 aurora-light:border-accent-info/30'
      : status.provider === 'codex'
        ? 'bg-orange-500/15 text-orange-400 aurora-light:text-accent-warning border-orange-500/30 aurora-light:border-accent-warning/30'
        : status.provider === 'gemini'
          ? 'bg-green-500/15 text-green-400 aurora-light:text-accent-success border-green-500/30 aurora-light:border-accent-success/30'
          : status.provider === 'kimi'
            ? 'bg-purple-500/15 text-purple-300 border-purple-500/30'
          : 'bg-red-500/15 text-red-400 aurora-light:text-destructive border-red-500/30 aurora-light:border-destructive/30'

  const tooltip =
    status.provider === null
      ? t('navbar.noCliTooltip')
      : t('navbar.activeCli', { label })

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={cn(
            'h-5 px-2 flex items-center rounded text-[10px] font-mono border cursor-default select-none',
            badgeClass
          )}
        >
          {label}
        </span>
      </TooltipTrigger>
      <TooltipContent>{tooltip}</TooltipContent>
    </Tooltip>
  )
}

export function Navbar() {
  const { t } = useTranslation('nav')
  return (
    <nav className="relative z-50 h-11 flex items-center justify-between px-4 border-b border-border bg-card/50 backdrop-blur-sm">
      {/* Wordmark */}
      <NavLink
        to="/"
        className="flex items-center gap-2 text-foreground hover:text-foreground/80 transition-colors"
      >
        <span className="font-mono text-sm font-bold"><span className="text-accent-primary">spec</span><span className="text-accent-secondary">rails</span></span>
        <span className="text-muted-foreground text-xs font-normal">/ manager</span>
      </NavLink>

      {/* Center nav links */}
      <div className="flex items-center gap-1">
        <NavLink
          to="/"
          end
          className={({ isActive }) =>
            cn(
              'h-7 px-2 flex items-center gap-1.5 rounded-md text-xs transition-colors',
              isActive
                ? 'text-foreground bg-accent'
                : 'text-muted-foreground hover:text-foreground hover:bg-accent'
            )
          }
        >
          <LayoutDashboard className="w-3.5 h-3.5" />
          <span>{t('navbar.home')}</span>
        </NavLink>
        <NavLink
          to="/analytics"
          className={({ isActive }) =>
            cn(
              'h-7 px-2 flex items-center gap-1.5 rounded-md text-xs transition-colors',
              isActive
                ? 'text-foreground bg-accent'
                : 'text-muted-foreground hover:text-foreground hover:bg-accent'
            )
          }
        >
          <BarChart3 className="w-3.5 h-3.5" />
          <span>{t('navbar.analytics')}</span>
        </NavLink>
      </div>

      {/* Right-side actions */}
      <div className="flex items-center gap-2">
        <CLIBadge />
        <Tooltip>
          <TooltipTrigger asChild>
            <a
              href="https://specrails.dev/docs"
              target="_blank"
              rel="noopener noreferrer"
              className="h-7 w-7 flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
            >
              <BookOpen className="w-3.5 h-3.5" />
            </a>
          </TooltipTrigger>
          <TooltipContent>{t('navbar.docs')}</TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <NavLink
              to="/settings"
              className={({ isActive }) =>
                cn(
                  'h-7 w-7 flex items-center justify-center rounded-md transition-colors',
                  isActive
                    ? 'text-foreground bg-accent'
                    : 'text-muted-foreground hover:text-foreground hover:bg-accent'
                )
              }
            >
              <Settings className="w-3.5 h-3.5" />
            </NavLink>
          </TooltipTrigger>
          <TooltipContent>{t('navbar.settings')}</TooltipContent>
        </Tooltip>
      </div>
    </nav>
  )
}
