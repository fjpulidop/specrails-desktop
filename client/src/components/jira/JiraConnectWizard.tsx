import { useState } from 'react'
import { toast } from 'sonner'
import { useTranslation } from 'react-i18next'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import {
  jiraApi,
  type JiraProjectOption,
  type JiraStatusOption,
  type SpecLogicalState,
} from '../../lib/jira-api'

type WizardStep = 1 | 2 | 3 | 4
type TestState = 'idle' | 'testing' | 'ok' | 'error'

const STATE_KEYS: SpecLogicalState[] = ['todo', 'in_progress', 'on_review', 'done', 'cancelled']
const STATE_LABEL: Record<SpecLogicalState, string> = {
  todo: 'todo',
  in_progress: 'inProgress',
  on_review: 'onReview',
  done: 'done',
  cancelled: 'cancelled',
}

export interface JiraConnectWizardProps {
  /** Called after a successful connect. */
  onConnected: () => void
  /** When provided, a "do it later" affordance is shown. */
  onSkip?: () => void
  /** Explicit API base (`/api/projects/<id>`); defaults to the active project. */
  apiBase?: string
}

/**
 * The reusable step-by-step Jira connect flow (Test → pick project → optional
 * status map → Connect). Mounted both in the project Settings page and in the
 * Add-Project setup wizard's final step. Keep it presentation-only: the caller
 * decides what `onConnected`/`onSkip` do (reload vs go-to-project).
 */
export function JiraConnectWizard({ onConnected, onSkip, apiBase }: JiraConnectWizardProps) {
  const { t } = useTranslation('jira')
  const [step, setStep] = useState<WizardStep>(1)

  // Step 1: credentials
  const [baseUrl, setBaseUrl] = useState('')
  const [email, setEmail] = useState('')
  const [token, setToken] = useState('')
  const [testState, setTestState] = useState<TestState>('idle')
  const [displayName, setDisplayName] = useState<string | null>(null)
  const [deployment, setDeployment] = useState<'cloud' | 'dc'>('cloud')

  // Step 2: project
  const [projects, setProjects] = useState<JiraProjectOption[]>([])
  const [projectQuery, setProjectQuery] = useState('')
  const [selectedKey, setSelectedKey] = useState('')
  const [selectedName, setSelectedName] = useState('')
  const [loadingProjects, setLoadingProjects] = useState(false)

  // Step 3: status map + discard ("move-to") status
  const [statuses, setStatuses] = useState<JiraStatusOption[]>([])
  const [statusMap, setStatusMap] = useState<Partial<Record<SpecLogicalState, string>>>({})
  const [discardStatus, setDiscardStatus] = useState('')

  const [connecting, setConnecting] = useState(false)
  const credsInput = () => ({ baseUrl: baseUrl.trim(), accountEmail: email.trim() || null, token })

  async function runTest() {
    setTestState('testing')
    try {
      const r = await jiraApi.test(credsInput(), apiBase)
      setTestState('ok')
      setDisplayName(r.displayName)
      setDeployment(r.deployment)
    } catch (e) {
      setTestState('error')
      toast.error(errMsg(e, t))
    }
  }

  async function goToProjects() {
    setStep(2)
    setLoadingProjects(true)
    try {
      const { projects: list } = await jiraApi.discoverProjects({ ...credsInput(), query: projectQuery.trim() || undefined }, apiBase)
      setProjects(list)
    } catch (e) {
      toast.error(errMsg(e, t))
    } finally {
      setLoadingProjects(false)
    }
  }

  async function goToMapping() {
    setStep(3)
    if (!selectedKey) return
    try {
      const { statuses: list } = await jiraApi.discoverStatuses({ ...credsInput(), projectKey: selectedKey }, apiBase)
      setStatuses(list)
    } catch {
      setStatuses([])
    }
  }

  async function connect() {
    setConnecting(true)
    try {
      const cleanMap = Object.fromEntries(Object.entries(statusMap).filter(([, v]) => v))
      await jiraApi.connect(
        {
          ...credsInput(),
          jiraProjectKey: selectedKey.trim(),
          statusMap: Object.keys(cleanMap).length ? (cleanMap as Partial<Record<SpecLogicalState, string>>) : null,
          discardStatus: discardStatus.trim() || null,
        },
        apiBase
      )
      toast.success(t('status.connected', { key: selectedKey.trim() }))
      onConnected()
    } catch (e) {
      toast.error(errMsg(e, t))
    } finally {
      setConnecting(false)
    }
  }

  return (
    <div className="space-y-4" data-testid="jira-wizard">
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">{t('wizard.step', { current: step, total: 4 })}</p>
        {onSkip && (
          <button type="button" onClick={onSkip} className="text-xs text-muted-foreground hover:text-foreground hover:underline" data-testid="jira-later">
            {t('wizard.later')}
          </button>
        )}
      </div>

      {step === 1 && (
        <div className="space-y-3">
          <h3 className="text-sm font-semibold">{t('wizard.step1Title')}</h3>
          <Field label={t('creds.baseUrlLabel')} help={t('creds.baseUrlHelp')}>
            <Input value={baseUrl} onChange={(e) => { setBaseUrl(e.target.value); setTestState('idle') }} placeholder={t('creds.baseUrlPlaceholder')} />
          </Field>
          <Field label={t('creds.emailLabel')} help={t('creds.emailHelp')}>
            <Input value={email} onChange={(e) => { setEmail(e.target.value); setTestState('idle') }} placeholder={t('creds.emailPlaceholder')} />
          </Field>
          <Field label={t('creds.tokenLabel')} help={t('creds.tokenHelp')}>
            <Input type="password" value={token} onChange={(e) => { setToken(e.target.value); setTestState('idle') }} />
          </Field>
          <div className="flex items-center gap-3">
            <Button size="sm" variant="outline" onClick={runTest} disabled={!baseUrl.trim() || !token.trim() || testState === 'testing'}>
              {testState === 'testing' ? t('creds.testing') : testState === 'ok' ? t('creds.retest') : t('creds.test')}
            </Button>
            {testState === 'ok' && (
              <span className="text-xs text-accent-success" data-testid="jira-test-ok">
                ✓ {t('creds.testOk', { name: displayName ?? '' })} · {deployment === 'cloud' ? t('review.cloud') : t('review.dc')}
              </span>
            )}
          </div>
          <div className="flex justify-end">
            <Button size="sm" onClick={goToProjects} disabled={testState !== 'ok'}>{t('wizard.next')}</Button>
          </div>
        </div>
      )}

      {step === 2 && (
        <div className="space-y-3">
          <h3 className="text-sm font-semibold">{t('wizard.step2Title')}</h3>
          <div className="flex gap-2">
            <Input value={projectQuery} onChange={(e) => setProjectQuery(e.target.value)} placeholder={t('project.searchPlaceholder')} />
            <Button size="sm" variant="outline" onClick={goToProjects}>{t('project.searchPlaceholder')}</Button>
          </div>
          {loadingProjects ? (
            <p className="text-xs text-muted-foreground">{t('project.loading')}</p>
          ) : projects.length === 0 ? (
            <p className="text-xs text-muted-foreground">{t('project.none')}</p>
          ) : (
            <div className="max-h-48 space-y-1 overflow-y-auto" data-testid="jira-project-list">
              {projects.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => { setSelectedKey(p.key); setSelectedName(p.name) }}
                  className={`flex w-full items-center justify-between rounded px-2 py-1.5 text-left text-sm hover:bg-muted ${selectedKey === p.key ? 'bg-muted' : ''}`}
                >
                  <span className="font-medium">{p.key}</span>
                  <span className="truncate text-xs text-muted-foreground">{p.name}</span>
                </button>
              ))}
            </div>
          )}
          <Field label={t('project.manualLabel')}>
            <Input value={selectedKey} onChange={(e) => { setSelectedKey(e.target.value.toUpperCase()); setSelectedName('') }} placeholder={t('project.manualPlaceholder')} />
          </Field>
          <div className="flex justify-between">
            <Button size="sm" variant="ghost" onClick={() => setStep(1)}>{t('wizard.back')}</Button>
            <Button size="sm" onClick={goToMapping} disabled={!selectedKey.trim()}>{t('wizard.next')}</Button>
          </div>
        </div>
      )}

      {step === 3 && (
        <div className="space-y-3">
          <h3 className="text-sm font-semibold">{t('wizard.step3Title')}</h3>
          <p className="text-xs text-muted-foreground">{t('mapping.intro')}</p>
          {STATE_KEYS.map((s) => (
            <Field key={s} label={t(`mapping.${STATE_LABEL[s]}`)}>
              <select
                value={statusMap[s] ?? ''}
                onChange={(e) => setStatusMap((m) => ({ ...m, [s]: e.target.value || undefined }))}
                className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm"
              >
                <option value="">{t('mapping.auto')}</option>
                {statuses.map((st) => (
                  <option key={st.id} value={st.name}>{st.name}</option>
                ))}
              </select>
            </Field>
          ))}
          <Field label={t('discard.configLabel')} help={t('discard.configHelp')}>
            <select
              value={discardStatus}
              onChange={(e) => setDiscardStatus(e.target.value)}
              className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm"
              data-testid="jira-discard-status-select"
            >
              <option value="">{t('discard.configNone')}</option>
              {statuses.map((st) => (
                <option key={st.id} value={st.name}>{st.name}</option>
              ))}
            </select>
          </Field>
          <div className="flex justify-between">
            <Button size="sm" variant="ghost" onClick={() => setStep(2)}>{t('wizard.back')}</Button>
            <Button size="sm" onClick={() => setStep(4)}>{t('wizard.next')}</Button>
          </div>
        </div>
      )}

      {step === 4 && (
        <div className="space-y-3">
          <h3 className="text-sm font-semibold">{t('wizard.step4Title')}</h3>
          <dl className="space-y-1 text-sm">
            <Row label={t('review.site')} value={baseUrl} />
            <Row label={t('review.project')} value={selectedName ? `${selectedKey} — ${selectedName}` : selectedKey} />
            <Row label={t('review.account')} value={displayName ?? email} />
            <Row label={t('review.type')} value={deployment === 'cloud' ? t('review.cloud') : t('review.dc')} />
            <Row label={t('discard.reviewLabel')} value={discardStatus || t('discard.configNone')} />
          </dl>
          <div className="flex justify-between">
            <Button size="sm" variant="ghost" onClick={() => setStep(3)}>{t('wizard.back')}</Button>
            <Button size="sm" onClick={connect} disabled={connecting}>{connecting ? t('wizard.connecting') : t('wizard.connect')}</Button>
          </div>
        </div>
      )}
    </div>
  )
}

function Field({ label, help, children }: { label: string; help?: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="text-xs font-medium text-foreground">{label}</span>
      {children}
      {help && <span className="block text-[11px] text-muted-foreground">{help}</span>}
    </label>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="truncate text-right font-medium">{value}</dd>
    </div>
  )
}

function errMsg(e: unknown, t: (k: string) => string): string {
  return e instanceof Error ? e.message : t('errors.generic')
}
