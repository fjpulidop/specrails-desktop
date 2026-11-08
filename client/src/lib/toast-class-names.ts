// Shared toast chrome for the app Toaster. A standalone module so tests can render
// the real Toaster with production classes without loading the whole App.
export const SPECRAILS_TOAST_CLASS_NAMES = {
  toast:
    'glass-card border border-border/30 text-foreground text-xs p-3 rounded-lg flex items-start gap-2 w-[356px] max-w-[min(356px,calc(100vw-2rem))] max-h-[calc(100vh-2rem)] pr-8 overflow-hidden shadow-lg',
  content: 'flex-1 min-w-0 flex flex-col gap-0.5',
  icon: 'shrink-0 mt-[2px] flex items-center justify-center',
  title: 'font-medium text-sm',
  description:
    'text-muted-foreground mt-0.5 min-w-0 max-h-[min(40vh,16rem)] overflow-y-auto whitespace-pre-wrap [overflow-wrap:anywhere]',
  actionButton:
    'text-xs px-2.5 py-1 rounded-md bg-primary text-primary-foreground hover:bg-primary/90 whitespace-normal max-w-[45%] shrink-0 self-start',
  cancelButton:
    'text-caption px-2.5 py-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent/50 whitespace-nowrap shrink-0 self-start',
  closeButton:
    'text-muted-foreground hover:text-foreground rounded-md p-0.5 absolute top-1.5 right-1.5',
  // Full 1px tinted border (no coloured side stripe on alerts).
  success: 'border-[color:var(--toast-success-border)]!',
  error: 'border-[color:var(--toast-error-border)]!',
  warning: 'border-[color:var(--toast-warning-border)]!',
  info: 'border-[color:var(--toast-info-border)]!',
  loading: '',
}
