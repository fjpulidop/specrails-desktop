import { Component, type ReactNode, type ErrorInfo } from 'react'
import { useTranslation, Trans } from 'react-i18next'
import { RefreshCw } from 'lucide-react'
import { Button } from '../../../components/ui/button'

interface Props {
  children: ReactNode
  projectName?: string
}

interface State {
  hasError: boolean
  error: Error | null
}

// Function-component fallback so the error UI can use i18n hooks (and
// re-render on hot language switch) while the boundary stays a class.
function ErrorFallback({
  projectName,
  errorMessage,
  onRetry,
}: {
  projectName?: string
  errorMessage: string | null
  onRetry: () => void
}) {
  const { t } = useTranslation('nav')
  return (
    <div className="flex flex-col items-center justify-center h-full gap-4 p-8">
      <div className="text-center space-y-2">
        <h2 className="text-title">{t('errorBoundary.title')}</h2>
        {projectName && (
          <p className="text-sm text-muted-foreground">
            <Trans
              ns="nav"
              i18nKey="errorBoundary.occurredIn"
              values={{ name: projectName }}
              components={{ strong: <span className="font-medium" /> }}
            />
          </p>
        )}
        <p className="max-w-md text-sm text-muted-foreground">{t('errorBoundary.description')}</p>
      </div>
      {errorMessage && (
        <details className="w-full max-w-md rounded-md border border-border bg-muted/20 px-3 py-2 text-xs">
          <summary className="cursor-pointer rounded-sm text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            {t('errorBoundary.details')}
          </summary>
          <p className="mt-2 break-words font-mono text-muted-foreground">{errorMessage}</p>
        </details>
      )}
      <Button onClick={onRetry} className="gap-2">
        <RefreshCw className="w-3.5 h-3.5" aria-hidden />
        {t('common:actions.retry')}
      </Button>
    </div>
  )
}

export class ProjectErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props)
    this.state = { hasError: false, error: null }
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[ProjectErrorBoundary]', error, info.componentStack)
  }

  handleRetry = () => {
    this.setState({ hasError: false, error: null })
  }

  render() {
    if (this.state.hasError) {
      return (
        <ErrorFallback
          projectName={this.props.projectName}
          errorMessage={this.state.error?.message ?? null}
          onRetry={this.handleRetry}
        />
      )
    }

    return this.props.children
  }
}
