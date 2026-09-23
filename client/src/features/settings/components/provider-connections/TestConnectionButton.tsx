import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2, PlugZap } from 'lucide-react'
import { Button } from '../../../../components/ui/button'
import type { RuntimeProviderTestResult } from '../../lib/agent-runtime'

interface Props {
  /** The DRAFT values — a test never saves. */
  baseUrl: string
  apiKeyEnv?: string
  disabled?: boolean
  onStart?: () => void
  onResult: (result: RuntimeProviderTestResult) => void
  onError: (message: string) => void
}

function isTestResult(value: unknown): value is RuntimeProviderTestResult {
  if (!value || typeof value !== 'object') return false
  const data = value as Partial<RuntimeProviderTestResult>
  return typeof data.reachable === 'boolean' && typeof data.authState === 'string'
}

/** POSTs the draft `{ baseUrl, apiKeyEnv }` to the probe route and hands back the reply. */
export function TestConnectionButton({ baseUrl, apiKeyEnv, disabled, onStart, onResult, onError }: Props) {
  const { t } = useTranslation('agentRuntime')
  const [testing, setTesting] = useState(false)
  async function test() {
    setTesting(true); onStart?.()
    try {
      const response = await fetch('/api/runtime-providers/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ baseUrl, ...(apiKeyEnv ? { apiKeyEnv } : {}) }),
      })
      const data = await response.json().catch(() => null)
      if (!response.ok || !isTestResult(data)) throw new Error((data as { message?: string } | null)?.message ?? t('providers.testFailed'))
      onResult({ ...data, models: Array.isArray(data.models) ? data.models : [] })
    } catch (error) {
      onError((error as Error).message || t('providers.testFailed'))
    } finally {
      setTesting(false)
    }
  }
  return (
    <Button type="button" variant="secondary" size="sm" disabled={disabled || testing || !baseUrl.trim()} onClick={() => void test()} className="gap-1.5">
      {testing ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <PlugZap className="h-3.5 w-3.5" aria-hidden />}
      {t(testing ? 'providers.testing' : 'providers.test')}
    </Button>
  )
}
