import { Component, type ReactNode, type ErrorInfo } from 'react'
import { useTranslation, Trans } from 'react-i18next'
import { RefreshCw } from 'lucide-react'

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
        <h2 className="text-base font-semibold">{t('errorBoundary.title')}</h2>
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
        {errorMessage && (
          <p className="text-xs text-muted-foreground/60 font-mono">{errorMessage}</p>
        )}
      </div>
      <button
        type="button"
        onClick={onRetry}
        className="flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
      >
        <RefreshCw className="w-3.5 h-3.5" />
        {t('common:actions.retry')}
      </button>
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
