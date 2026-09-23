/**
 * A pending-spec id is the stable per-Explore-session key used for the attachment
 * directory (`~/.specrails/projects/<slug>/attachments/<pendingSpecId>/`) and for
 * the "From a website" browser capture. It MUST be a non-empty, filesystem-safe
 * opaque token (the server validates it against `^[A-Za-z0-9_-]{1,128}$`); an
 * empty value breaks attachment upload and makes capture 400 with
 * "pendingSpecId is required".
 */
export function genPendingSpecId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  // Fallback for environments without crypto.randomUUID (should not hit in a
  // modern webview, but keeps this id-generation total).
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    const v = c === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}
