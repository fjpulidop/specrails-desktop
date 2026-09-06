import type { RunInvocationHooks } from '../spawn-lifecycle'

export interface LiveInput {
  /** Stable correlation ID; a transport must never send this input twice. */
  id: string
  text: string
  imagePaths?: string[]
}

export interface LiveInputSink {
  /** Meaning of onAccepted for this transport. Omitted means received only;
   * read requires a provider signal that the input entered the active context. */
  readonly acceptedReceipt?: 'received' | 'read'
  /** True only after native acceptance. False means no input was accepted and
   * normal continuation is safe. An ambiguous error must never be replayed. */
  send(input: LiveInput, onAccepted?: () => void): Promise<boolean>
}

export class LiveInputDeliveryError extends Error {
  constructor(message: string, readonly ambiguous: boolean) {
    super(message)
    this.name = 'LiveInputDeliveryError'
  }
}

export interface LiveSessionHooks extends RunInvocationHooks {
  onInputReady?: (sink: LiveInputSink) => void
  /** Native acceptance of the initial prompt, never merely a successful write.
   * Invoked synchronously before parsing subsequent provider output. */
  onInitialInputAccepted?: () => void
}
