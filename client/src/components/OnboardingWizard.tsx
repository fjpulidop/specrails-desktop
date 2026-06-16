import { useState, useCallback, useMemo } from 'react'
import { useTranslation, Trans } from 'react-i18next'
import type { TFunction } from 'i18next'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import {
  Sparkles,
  MessageSquare,
  Zap,
  Globe,
  Scissors,
  Save,
  Columns2,
  Workflow,
  GitBranch,
  Bot,
  Gauge,
  FolderOpen,
  Coins,
  DollarSign,
  Wallet,
  Receipt,
  Boxes,
  Terminal,
  FileCode,
  Plug,
  Palette,
  Layers,
  Command,
  Keyboard,
  Rocket,
  ShieldCheck,
  ArrowRight,
  ArrowLeft,
  Check,
  Languages,
  Smartphone,
  QrCode,
  ExternalLink,
} from 'lucide-react'
import { QRCodeSVG } from 'qrcode.react'
import { cn } from '../lib/utils'
import { Button } from './ui/button'
import { LanguagePickerGrid } from './pickers/LanguagePickerGrid'
import { ThemePickerGrid } from './pickers/ThemePickerGrid'
import { COMPANION_WEB_URL } from '../lib/companion'
import { FEATURE_JIRA } from '../lib/feature-flags'

const ONBOARDING_KEY = 'specrails-desktop:onboarding-dismissed'

export function hasSeenOnboarding(): boolean {
  try {
    return localStorage.getItem(ONBOARDING_KEY) === 'true'
  } catch {
    return false
  }
}

export function resetOnboarding(): void {
  try {
    localStorage.removeItem(ONBOARDING_KEY)
  } catch {
    // ignore
  }
}

function dismissOnboarding(): void {
  try {
    localStorage.setItem(ONBOARDING_KEY, 'true')
  } catch {
    // ignore
  }
}

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || '')
const MOD = isMac ? '⌘' : 'Ctrl'
const ALT = isMac ? '⌥' : 'Alt'

// ─── Accent palette ─────────────────────────────────────────────────────────
// Literal class strings (no interpolation) so Tailwind keeps them in the build.

interface Accent {
  text: string
  bar: string
  glow: string
  btn: string
  softBorder: string
  softBg: string
  chipBg: string
}

const ACCENTS: Record<string, Accent> = {
  primary: {
    text: 'text-accent-primary',
    bar: 'bg-accent-primary',
    glow: 'glow-primary',
    btn: 'bg-accent-primary hover:bg-accent-primary/90 text-primary-foreground',
    softBorder: 'border-accent-primary/30',
    softBg: 'bg-accent-primary/5',
    chipBg: 'bg-accent-primary/10 text-accent-primary',
  },
  info: {
    text: 'text-accent-info',
    bar: 'bg-accent-info',
    glow: 'glow-info',
    btn: 'bg-accent-info hover:bg-accent-info/90 text-primary-foreground',
    softBorder: 'border-accent-info/30',
    softBg: 'bg-accent-info/5',
    chipBg: 'bg-accent-info/10 text-accent-info',
  },
  success: {
    text: 'text-accent-success',
    bar: 'bg-accent-success',
    glow: 'glow-success',
    btn: 'bg-accent-success hover:bg-accent-success/90 text-primary-foreground',
    softBorder: 'border-accent-success/30',
    softBg: 'bg-accent-success/5',
    chipBg: 'bg-accent-success/10 text-accent-success',
  },
  secondary: {
    text: 'text-accent-secondary',
    bar: 'bg-accent-secondary',
    glow: 'glow-secondary',
    btn: 'bg-accent-secondary hover:bg-accent-secondary/90 text-primary-foreground',
    softBorder: 'border-accent-secondary/30',
    softBg: 'bg-accent-secondary/5',
    chipBg: 'bg-accent-secondary/10 text-accent-secondary',
  },
  warning: {
    text: 'text-accent-warning',
    bar: 'bg-accent-warning',
    glow: 'glow-warning',
    btn: 'bg-accent-warning hover:bg-accent-warning/90 text-primary-foreground',
    softBorder: 'border-accent-warning/30',
    softBg: 'bg-accent-warning/5',
    chipBg: 'bg-accent-warning/10 text-accent-warning',
  },
  highlight: {
    text: 'text-accent-highlight',
    bar: 'bg-accent-highlight',
    glow: 'glow-highlight',
    btn: 'bg-accent-highlight hover:bg-accent-highlight/90 text-primary-foreground',
    softBorder: 'border-accent-highlight/30',
    softBg: 'bg-accent-highlight/5',
    chipBg: 'bg-accent-highlight/10 text-accent-highlight',
  },
}

// ─── Reusable bits ────────────────────────────────────────────────────────────

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="inline-flex items-center justify-center min-w-[1.5rem] h-5 px-1.5 rounded border border-border/60 bg-card/80 font-mono text-[11px] text-foreground shadow-sm">
      {children}
    </kbd>
  )
}

function Feature({
  icon,
  label,
  children,
  accent,
}: {
  icon: React.ReactNode
  label: string
  children: React.ReactNode
  accent: Accent
}) {
  return (
    <div className="flex gap-3 items-start">
      <div className={cn('mt-0.5 shrink-0 grid place-items-center w-7 h-7 rounded-md border border-border/40', accent.softBg, accent.text)}>
        {icon}
      </div>
      <div className="min-w-0">
        <p className="text-[13px] font-semibold text-foreground leading-tight">{label}</p>
        <p className="mt-0.5 text-xs text-muted-foreground leading-relaxed">{children}</p>
      </div>
    </div>
  )
}

function Callout({ accent, label, children }: { accent: Accent; label?: string; children: React.ReactNode }) {
  return (
    <div className={cn('rounded-lg border p-3', accent.softBorder, accent.softBg)}>
      {label && <p className={cn('text-[10px] font-semibold uppercase tracking-wider mb-1.5', accent.text)}>{label}</p>}
      <div className="text-xs text-foreground/90 leading-relaxed">{children}</div>
    </div>
  )
}

function FlowStrip({ steps }: { steps: { label: string; cls: string }[] }) {
  return (
    <div className="flex items-center gap-2 flex-wrap text-[13px] font-medium">
      {steps.map((s, i) => (
        <span key={s.label} className="flex items-center gap-2">
          <span className={s.cls}>{s.label}</span>
          {i < steps.length - 1 && <ArrowRight className="w-3.5 h-3.5 text-muted-foreground" />}
        </span>
      ))}
    </div>
  )
}

// ─── Interactive step bodies ─────────────────────────────────────────────────
// These need hooks (theme/language context), so they are components rather
// than static JSX inside buildSteps. Without a provider mounted the grids
// degrade to null and only the step copy renders.

function LanguageStepBody() {
  const { t } = useTranslation('setup')
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground leading-relaxed">
        {t('onboarding.language.intro')}
      </p>
      <LanguagePickerGrid />
      <p className="text-xs text-muted-foreground italic">{t('onboarding.language.note')}</p>
    </div>
  )
}

function ThemeStepBody() {
  const { t } = useTranslation('setup')
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground leading-relaxed">
        {t('onboarding.theme.intro')}
      </p>
      <ThemePickerGrid />
      <p className="text-xs text-muted-foreground italic">{t('onboarding.theme.note')}</p>
    </div>
  )
}

function CompanionDownloadCard({
  icon,
  url,
  label,
  testId,
}: {
  icon: React.ReactNode
  url: string
  label: string
  testId: string
}) {
  return (
    <div className="flex items-center gap-3 rounded-lg border border-border/40 bg-card/40 p-3">
      <div className="shrink-0 rounded-md bg-white p-1.5" aria-hidden="true">
        <QRCodeSVG value={url} size={72} />
      </div>
      <div className="min-w-0 space-y-1">
        <p className="flex items-center gap-1.5 text-[13px] font-semibold text-foreground leading-tight">
          {icon}
          {label}
        </p>
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          data-testid={testId}
          aria-label={label}
          className="inline-flex items-center gap-1 text-xs text-accent-info hover:underline break-all"
        >
          {url.replace('https://', '')}
          <ExternalLink className="w-3 h-3 shrink-0" aria-hidden="true" />
        </a>
      </div>
    </div>
  )
}

function CompanionStepBody() {
  const { t } = useTranslation('setup')
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground leading-relaxed">
        <Trans t={t} i18nKey="onboarding.companion.intro" components={{ b: <span className="text-foreground font-medium" /> }} />
      </p>
      <Callout accent={ACCENTS.success} label={t('onboarding.companion.localLabel')}>
        {t('onboarding.companion.localBody')}
      </Callout>
      <div className="space-y-2">
        <p className="text-[13px] font-semibold text-foreground">{t('onboarding.companion.downloadLabel')}</p>
        <p className="text-xs text-muted-foreground">{t('onboarding.companion.downloadHint')}</p>
        <CompanionDownloadCard
          icon={<Smartphone className="w-4 h-4 shrink-0" aria-hidden="true" />}
          url={COMPANION_WEB_URL}
          label={t('onboarding.companion.open')}
          testId="companion-web-link"
        />
      </div>
      <Feature icon={<QrCode className="w-4 h-4" />} label={t('onboarding.companion.pairLabel')} accent={ACCENTS.success}>
        {t('onboarding.companion.pairBody')}
      </Feature>
    </div>
  )
}

// ─── Step definitions ───────────────────────────────────────────────────────

interface StepConfig {
  navLabel: string
  icon: React.ReactNode
  accent: Accent
  title: string
  subtitle: string
  content: React.ReactNode
}

function buildSteps(t: TFunction): StepConfig[] {
  return [
    // 1 — Language (hot-switches the rest of the tour immediately)
    {
      navLabel: t('onboarding.language.nav'),
      icon: <Languages className="w-6 h-6" />,
      accent: ACCENTS.info,
      title: t('onboarding.language.title'),
      subtitle: t('onboarding.language.subtitle'),
      content: <LanguageStepBody />,
    },

    // 2 — Theme (applies live behind the dialog)
    {
      navLabel: t('onboarding.theme.nav'),
      icon: <Palette className="w-6 h-6" />,
      accent: ACCENTS.highlight,
      title: t('onboarding.theme.title'),
      subtitle: t('onboarding.theme.subtitle'),
      content: <ThemeStepBody />,
    },

    // 3 — Welcome
    {
      navLabel: t('onboarding.welcome.nav'),
      icon: <Sparkles className="w-6 h-6" />,
      accent: ACCENTS.primary,
      title: t('onboarding.welcome.title'),
      subtitle: t('onboarding.welcome.subtitle'),
      content: (
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground leading-relaxed">
            <Trans t={t} i18nKey="onboarding.welcome.intro" components={{ b: <span className="text-foreground font-medium" /> }} />
          </p>
          <Callout accent={ACCENTS.primary} label={t('onboarding.welcome.coreLoopLabel')}>
            <FlowStrip
              steps={[
                { label: t('onboarding.flow.addSpec'), cls: 'text-accent-info' },
                { label: t('onboarding.flow.dropInRail'), cls: 'text-accent-success' },
                { label: t('onboarding.flow.hitPlay'), cls: 'text-accent-warning' },
                { label: t('onboarding.flow.ship'), cls: 'text-accent-secondary' },
              ]}
            />
            <p className="mt-2 text-[11px] text-muted-foreground">
              <Trans t={t} i18nKey="onboarding.welcome.flowCaption" components={{ b: <span className="text-foreground" /> }} />
            </p>
          </Callout>
          <div className="flex gap-3 items-start">
            <ShieldCheck className="w-4 h-4 mt-0.5 shrink-0 text-accent-success" />
            <p className="text-xs text-muted-foreground leading-relaxed">
              <Trans
                t={t}
                i18nKey="onboarding.welcome.localNote"
                components={{ b: <span className="text-foreground font-medium" />, i: <span className="italic" /> }}
              />
            </p>
          </div>
          <p className="text-xs text-muted-foreground italic">{t('onboarding.welcome.tourNote')}</p>
        </div>
      ),
    },

    // 4 — Author specs
    {
      navLabel: t('onboarding.authorSpecs.nav'),
      icon: <MessageSquare className="w-6 h-6" />,
      accent: ACCENTS.info,
      title: t('onboarding.authorSpecs.title'),
      subtitle: t('onboarding.authorSpecs.subtitle'),
      content: (
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground leading-relaxed">
            <Trans t={t} i18nKey="onboarding.authorSpecs.intro" components={{ b: <span className="text-foreground font-medium" /> }} />
          </p>
          <div className="grid sm:grid-cols-2 gap-x-5 gap-y-4">
            <Feature icon={<MessageSquare className="w-4 h-4" />} label={t('onboarding.authorSpecs.exploreLabel')} accent={ACCENTS.info}>
              {t('onboarding.authorSpecs.exploreBody')}
            </Feature>
            <Feature icon={<Zap className="w-4 h-4" />} label={t('onboarding.authorSpecs.quickLabel')} accent={ACCENTS.info}>
              {t('onboarding.authorSpecs.quickBody')}
            </Feature>
            <Feature icon={<Globe className="w-4 h-4" />} label={t('onboarding.authorSpecs.websiteLabel')} accent={ACCENTS.info}>
              {t('onboarding.authorSpecs.websiteBody')}
            </Feature>
            <Feature icon={<Scissors className="w-4 h-4" />} label={t('onboarding.authorSpecs.smashLabel')} accent={ACCENTS.info}>
              {t('onboarding.authorSpecs.smashBody')}
            </Feature>
            <Feature icon={<Save className="w-4 h-4" />} label={t('onboarding.authorSpecs.draftsLabel')} accent={ACCENTS.info}>
              {t('onboarding.authorSpecs.draftsBody')}
            </Feature>
            <Feature icon={<Columns2 className="w-4 h-4" />} label={t('onboarding.authorSpecs.compareLabel')} accent={ACCENTS.info}>
              {t('onboarding.authorSpecs.compareBody')}
            </Feature>
          </div>
          {FEATURE_JIRA && (
            <Callout accent={ACCENTS.info} label={t('onboarding.jira.label')}>
              <Trans t={t} i18nKey="onboarding.jira.body" components={{ b: <span className="text-foreground font-medium" /> }} />
            </Callout>
          )}
        </div>
      ),
    },

    // 5 — Run the pipeline (rails)
    {
      navLabel: t('onboarding.rails.nav'),
      icon: <Workflow className="w-6 h-6" />,
      accent: ACCENTS.success,
      title: t('onboarding.rails.title'),
      subtitle: t('onboarding.rails.subtitle'),
      content: (
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground leading-relaxed">
            <Trans
              t={t}
              i18nKey="onboarding.rails.intro"
              components={{
                b: <span className="text-foreground font-medium" />,
                play: <span className="text-accent-warning font-medium" />,
              }}
            />
          </p>
          <Callout accent={ACCENTS.success} label={t('onboarding.rails.jobLabel')}>
            <FlowStrip
              steps={[
                { label: t('onboarding.flow.architect'), cls: 'text-accent-info' },
                { label: t('onboarding.flow.developer'), cls: 'text-accent-success' },
                { label: t('onboarding.flow.reviewer'), cls: 'text-accent-warning' },
                { label: t('onboarding.flow.ship'), cls: 'text-accent-secondary' },
              ]}
            />
            <p className="mt-2 text-[11px] text-muted-foreground">{t('onboarding.rails.flowCaption')}</p>
          </Callout>
          <div className="grid sm:grid-cols-2 gap-x-5 gap-y-4">
            <Feature icon={<GitBranch className="w-4 h-4" />} label={t('onboarding.rails.modeLabel')} accent={ACCENTS.success}>
              <Trans t={t} i18nKey="onboarding.rails.modeBody" components={{ b: <span className="text-foreground" /> }} />
            </Feature>
            <Feature icon={<Bot className="w-4 h-4" />} label={t('onboarding.rails.profilesLabel')} accent={ACCENTS.success}>
              {t('onboarding.rails.profilesBody')}
            </Feature>
            <Feature icon={<Gauge className="w-4 h-4" />} label={t('onboarding.rails.jobDetailLabel')} accent={ACCENTS.success}>
              {t('onboarding.rails.jobDetailBody')}
            </Feature>
            <Feature icon={<FolderOpen className="w-4 h-4" />} label={t('onboarding.rails.isolationLabel')} accent={ACCENTS.success}>
              {t('onboarding.rails.isolationBody')}
            </Feature>
          </div>
        </div>
      ),
    },

    // 6 — Providers
    {
      navLabel: t('onboarding.providers.nav'),
      icon: <Bot className="w-6 h-6" />,
      accent: ACCENTS.secondary,
      title: t('onboarding.providers.title'),
      subtitle: t('onboarding.providers.subtitle'),
      content: (
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground leading-relaxed">
            <Trans t={t} i18nKey="onboarding.providers.intro" components={{ b: <span className="text-foreground font-medium" /> }} />
          </p>
          <div className="rounded-lg border border-border/40 overflow-hidden text-xs">
            <div className="grid grid-cols-[1.4fr_1fr_1fr] bg-card/40">
              <div className="px-3 py-2 font-semibold text-muted-foreground">{t('onboarding.providers.table.capability')}</div>
              <div className="px-3 py-2 font-semibold text-accent-secondary text-center">Claude Code</div>
              <div className="px-3 py-2 font-semibold text-accent-success text-center">Codex CLI</div>
            </div>
            {[
              [t('onboarding.providers.table.streamingResume'), t('onboarding.providers.table.native'), t('onboarding.providers.table.native')],
              [t('onboarding.providers.table.costReporting'), t('onboarding.providers.table.providerBilled'), t('onboarding.providers.table.estimated')],
              [t('onboarding.providers.table.telemetry'), t('onboarding.providers.table.native'), t('onboarding.providers.table.synthesized')],
              [t('onboarding.providers.table.agentProfiles'), t('common:states.yes'), '—'],
            ].map((row) => (
              <div key={row[0]} className="grid grid-cols-[1.4fr_1fr_1fr] border-t border-border/30">
                <div className="px-3 py-2 text-foreground/90">{row[0]}</div>
                <div className="px-3 py-2 text-center text-muted-foreground">{row[1]}</div>
                <div className="px-3 py-2 text-center text-muted-foreground">{row[2]}</div>
              </div>
            ))}
          </div>
          <Callout accent={ACCENTS.secondary} label={t('onboarding.providers.calloutLabel')}>
            <Trans
              t={t}
              i18nKey="onboarding.providers.calloutBody"
              components={{ b: <span className="text-foreground" />, mono: <span className="font-mono" /> }}
            />
          </Callout>
        </div>
      ),
    },

    // 7 — Cost
    {
      navLabel: t('onboarding.cost.nav'),
      icon: <Coins className="w-6 h-6" />,
      accent: ACCENTS.warning,
      title: t('onboarding.cost.title'),
      subtitle: t('onboarding.cost.subtitle'),
      content: (
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground leading-relaxed">
            <Trans t={t} i18nKey="onboarding.cost.intro" components={{ b: <span className="text-foreground font-medium" /> }} />
          </p>
          <div className="grid sm:grid-cols-2 gap-x-5 gap-y-4">
            <Feature icon={<Gauge className="w-4 h-4" />} label={t('onboarding.cost.analyticsLabel')} accent={ACCENTS.warning}>
              {t('onboarding.cost.analyticsBody')}
            </Feature>
            <Feature icon={<Receipt className="w-4 h-4" />} label={t('onboarding.cost.perTicketLabel')} accent={ACCENTS.warning}>
              {t('onboarding.cost.perTicketBody')}
            </Feature>
            <Feature icon={<DollarSign className="w-4 h-4" />} label={t('onboarding.cost.honestLabel')} accent={ACCENTS.warning}>
              <Trans t={t} i18nKey="onboarding.cost.honestBody" components={{ mono: <span className="font-mono" /> }} />
            </Feature>
            <Feature icon={<Wallet className="w-4 h-4" />} label={t('onboarding.cost.budgetsLabel')} accent={ACCENTS.warning}>
              {t('onboarding.cost.budgetsBody')}
            </Feature>
          </div>
        </div>
      ),
    },

    // 8 — Workspace
    {
      navLabel: t('onboarding.workspace.nav'),
      icon: <Boxes className="w-6 h-6" />,
      accent: ACCENTS.highlight,
      title: t('onboarding.workspace.title'),
      subtitle: t('onboarding.workspace.subtitle'),
      content: (
        <div className="space-y-4">
          <div className="grid sm:grid-cols-2 gap-x-5 gap-y-4">
            <Feature icon={<Terminal className="w-4 h-4" />} label={t('onboarding.workspace.terminalLabel')} accent={ACCENTS.highlight}>
              <Trans
                t={t}
                i18nKey="onboarding.workspace.terminalBody"
                values={{ mod: MOD }}
                components={{ mod: <Kbd>{MOD}</Kbd>, j: <Kbd>J</Kbd> }}
              />
            </Feature>
            <Feature icon={<FileCode className="w-4 h-4" />} label={t('onboarding.workspace.codeLabel')} accent={ACCENTS.highlight}>
              {t('onboarding.workspace.codeBody')}
            </Feature>
            <Feature icon={<Plug className="w-4 h-4" />} label={t('onboarding.workspace.integrationsLabel')} accent={ACCENTS.highlight}>
              {t('onboarding.workspace.integrationsBody')}
            </Feature>
            <Feature icon={<Palette className="w-4 h-4" />} label={t('onboarding.workspace.themesLabel')} accent={ACCENTS.highlight}>
              {t('onboarding.workspace.themesBody')}
            </Feature>
            <Feature icon={<Layers className="w-4 h-4" />} label={t('onboarding.workspace.chatsLabel')} accent={ACCENTS.highlight}>
              {t('onboarding.workspace.chatsBody')}
            </Feature>
            <Feature icon={<Rocket className="w-4 h-4" />} label={t('onboarding.workspace.desktopLabel')} accent={ACCENTS.highlight}>
              {t('onboarding.workspace.desktopBody')}
            </Feature>
          </div>
        </div>
      ),
    },

    // 9 — Companion mobile app
    {
      navLabel: t('onboarding.companion.nav'),
      icon: <Smartphone className="w-6 h-6" />,
      accent: ACCENTS.success,
      title: t('onboarding.companion.title'),
      subtitle: t('onboarding.companion.subtitle'),
      content: <CompanionStepBody />,
    },

    // 10 — Move fast / get started
    {
      navLabel: t('onboarding.moveFast.nav'),
      icon: <Command className="w-6 h-6" />,
      accent: ACCENTS.primary,
      title: t('onboarding.moveFast.title'),
      subtitle: t('onboarding.moveFast.subtitle'),
      content: (
        <div className="space-y-4">
          <Callout accent={ACCENTS.primary} label={t('onboarding.moveFast.paletteLabel')}>
            <div className="flex items-center gap-2 mb-1.5">
              <Trans
                t={t}
                i18nKey="onboarding.moveFast.paletteShortcut"
                values={{ mod: MOD }}
                components={{
                  f: <span className="text-foreground" />,
                  m: <span className="text-muted-foreground" />,
                  mod: <Kbd>{MOD}</Kbd>,
                  k: <Kbd>K</Kbd>,
                }}
              />
            </div>
            {t('onboarding.moveFast.paletteBody')}
          </Callout>
          <div className="grid sm:grid-cols-2 gap-x-5 gap-y-3">
            <Feature icon={<Terminal className="w-4 h-4" />} label={t('onboarding.moveFast.terminalLabel')} accent={ACCENTS.primary}>
              <Trans
                t={t}
                i18nKey="onboarding.moveFast.terminalBody"
                values={{ mod: MOD }}
                components={{ mod: <Kbd>{MOD}</Kbd>, j: <Kbd>J</Kbd> }}
              />
            </Feature>
            <Feature icon={<Keyboard className="w-4 h-4" />} label={t('onboarding.moveFast.shortcutsLabel')} accent={ACCENTS.primary}>
              <Trans t={t} i18nKey="onboarding.moveFast.shortcutsBody" components={{ q: <Kbd>?</Kbd> }} />
            </Feature>
            <Feature icon={<MessageSquare className="w-4 h-4" />} label={t('onboarding.moveFast.chatLabel')} accent={ACCENTS.primary}>
              <Trans
                t={t}
                i18nKey="onboarding.moveFast.chatBody"
                values={{ mod: MOD }}
                components={{ mod: <Kbd>{MOD}</Kbd>, bkey: <Kbd>B</Kbd> }}
              />
            </Feature>
            <Feature icon={<FolderOpen className="w-4 h-4" />} label={t('onboarding.moveFast.projectsLabel')} accent={ACCENTS.primary}>
              <Trans
                t={t}
                i18nKey="onboarding.moveFast.projectsBody"
                values={{ alt: ALT, mod: MOD }}
                components={{ alt: <Kbd>{ALT}</Kbd>, mod: <Kbd>{MOD}</Kbd>, bkey: <Kbd>B</Kbd> }}
              />
            </Feature>
          </div>
          <Callout accent={ACCENTS.primary}>
            <Trans t={t} i18nKey="onboarding.moveFast.outro" components={{ b: <span className="text-foreground font-medium" /> }} />
          </Callout>
        </div>
      ),
    },
  ]
}

// ─── OnboardingWizard ─────────────────────────────────────────────────────────

interface OnboardingWizardProps {
  open: boolean
  onClose: () => void
}

export function OnboardingWizard({ open, onClose }: OnboardingWizardProps) {
  const { t } = useTranslation('setup')
  const [step, setStep] = useState(0)
  const [dontShowAgain, setDontShowAgain] = useState(false)

  const steps = useMemo(() => buildSteps(t), [t])
  const current = steps[step]
  const isFirst = step === 0
  const isLast = step === steps.length - 1

  const handleClose = useCallback(() => {
    if (dontShowAgain) dismissOnboarding()
    setStep(0)
    onClose()
  }, [dontShowAgain, onClose])

  // Completing the whole tour counts as "seen".
  const handleFinish = useCallback(() => {
    dismissOnboarding()
    setStep(0)
    onClose()
  }, [onClose])

  const handleNext = useCallback(() => {
    if (isLast) handleFinish()
    else setStep((s) => s + 1)
  }, [isLast, handleFinish])

  const handleBack = useCallback(() => setStep((s) => Math.max(0, s - 1)), [])

  return (
    <DialogPrimitive.Root open={open} onOpenChange={(isOpen) => { if (!isOpen) handleClose() }}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/70 backdrop-blur-md data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
        <DialogPrimitive.Content
          // Fixed height (not just max-h) so EVERY step is exactly the same size —
          // the dialog never resizes between steps, which keeps the footer's
          // Back / Next / Skip buttons pinned in the same place. Wider + taller
          // than before for a roomier tour; the per-step body scrolls internally
          // when it overflows instead of growing the dialog.
          className="fixed left-[50%] top-[50%] z-50 flex flex-col w-[calc(100vw-2rem)] max-w-5xl h-[min(88vh,820px)] translate-x-[-50%] translate-y-[-50%] overflow-hidden border border-border/30 bg-popover shadow-2xl backdrop-blur-xl sm:rounded-2xl duration-200 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95"
          data-testid="onboarding-wizard"
          aria-describedby="onboarding-description"
        >
          {/* Accent glow bar */}
          <div className={cn('h-1 w-full shrink-0 transition-all duration-500', current.accent.bar)} />

          <div className="flex min-h-0 flex-1">
            {/* ── Left step navigation ── */}
            <nav className="hidden md:flex w-60 shrink-0 flex-col border-r border-border/30 bg-card/20 p-4">
              <div className="px-2 mb-5">
                <p className="text-sm font-bold tracking-tight">
                  <span className="text-accent-primary">spec</span>
                  <span className="text-accent-secondary">rails</span>
                </p>
                <p className="text-[10px] text-muted-foreground mt-0.5">{t('onboarding.productTour')}</p>
              </div>
              <ol className="space-y-0.5 min-h-0 overflow-y-auto">
                {steps.map((s, i) => {
                  const isActive = i === step
                  const isDone = i < step
                  return (
                    <li key={s.navLabel}>
                      <button
                        type="button"
                        onClick={() => setStep(i)}
                        aria-label={t('onboarding.goToStep', { step: i + 1, label: s.navLabel })}
                        aria-current={isActive ? 'step' : undefined}
                        className={cn(
                          'w-full flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors',
                          isActive ? cn('bg-card/70', s.accent.text) : 'text-muted-foreground hover:bg-card/40 hover:text-foreground'
                        )}
                      >
                        <span
                          className={cn(
                            'grid place-items-center w-5 h-5 shrink-0 rounded-full text-[10px] font-bold border',
                            isActive
                              ? cn(s.accent.bar, 'text-primary-foreground border-transparent')
                              : isDone
                                ? 'bg-accent-success/15 text-accent-success border-accent-success/30'
                                : 'border-border/50 text-muted-foreground'
                          )}
                        >
                          {isDone ? <Check className="w-3 h-3" /> : i + 1}
                        </span>
                        <span className="text-xs font-medium truncate">{s.navLabel}</span>
                      </button>
                    </li>
                  )
                })}
              </ol>
              <div className="mt-auto px-2.5 pt-4 text-[10px] text-muted-foreground">
                {t('onboarding.stepCount', { current: step + 1, total: steps.length })}
              </div>
            </nav>

            {/* ── Right content ── */}
            <div className="flex min-w-0 flex-1 flex-col">
              <div className="flex-1 overflow-y-auto p-6 sm:p-7">
                {/* Header */}
                <div className={cn('flex items-center gap-3.5 mb-5', current.accent.text)}>
                  <div className={cn('grid place-items-center w-12 h-12 shrink-0 rounded-xl border border-border/30 bg-card/40', current.accent.glow)}>
                    {current.icon}
                  </div>
                  <div className="min-w-0">
                    <DialogPrimitive.Title className="text-lg font-bold leading-tight text-foreground">
                      {current.title}
                    </DialogPrimitive.Title>
                    <p id="onboarding-description" className="text-xs text-muted-foreground mt-0.5">
                      {current.subtitle}
                    </p>
                  </div>
                </div>

                {/* Mobile progress (left nav hidden) */}
                <div className="md:hidden flex items-center gap-1.5 mb-5">
                  {steps.map((s, i) => (
                    <button
                      key={s.navLabel}
                      type="button"
                      onClick={() => setStep(i)}
                      aria-label={t('onboarding.stepLabel', { step: i + 1 })}
                      aria-current={i === step ? 'step' : undefined}
                      className={cn('h-1.5 rounded-full transition-all', i === step ? cn('w-6', s.accent.bar) : 'w-1.5 bg-muted-foreground/30')}
                    />
                  ))}
                </div>

                {/* Step body */}
                <div className="min-h-[300px]">{current.content}</div>
              </div>

              {/* Footer */}
              <div className="flex items-center justify-between gap-3 border-t border-border/30 px-6 sm:px-7 py-3.5">
                <div className="flex-1 min-w-0">
                  {isFirst && (
                    <label className="inline-flex items-center gap-2 cursor-pointer group">
                      <input
                        type="checkbox"
                        checked={dontShowAgain}
                        onChange={(e) => setDontShowAgain(e.target.checked)}
                        className="w-3.5 h-3.5 rounded"
                        data-testid="onboarding-dismiss-checkbox"
                      />
                      <span className="text-[11px] text-muted-foreground group-hover:text-foreground transition-colors">
                        {t('onboarding.dontShowAgain')}
                      </span>
                    </label>
                  )}
                </div>

                <div className="flex items-center gap-2">
                  {isFirst ? (
                    <Button variant="ghost" size="sm" onClick={handleClose} className="text-xs text-muted-foreground" data-testid="onboarding-skip">
                      {t('onboarding.skipTour')}
                    </Button>
                  ) : (
                    <Button variant="ghost" size="sm" onClick={handleBack} className="text-xs" data-testid="onboarding-back">
                      <ArrowLeft className="w-3.5 h-3.5 mr-1" />
                      {t('common:actions.back')}
                    </Button>
                  )}
                  <Button size="sm" onClick={handleNext} className={cn('text-xs', current.accent.btn)} data-testid="onboarding-next">
                    {isLast ? t('onboarding.getStarted') : t('common:actions.next')}
                    {!isLast && <ArrowRight className="w-3.5 h-3.5 ml-1" />}
                  </Button>
                </div>
              </div>
            </div>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}
