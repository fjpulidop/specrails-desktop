/**
 * Decode a `data:` URL into a File WITHOUT `fetch()`. The packaged Tauri app's
 * CSP `connect-src` does not include `data:` (src-tauri/tauri.conf.json), so
 * `fetch(dataUrl)` is refused by the webview ("Load failed") even though the
 * same URL renders fine as an <img src> (`img-src` does allow `data:`). Dev
 * builds have no CSP, which is why this class of bug only appears packaged.
 */
export function dataUrlToFile(dataUrl: string, filename: string): File {
  const comma = dataUrl.indexOf(',')
  if (!dataUrl.startsWith('data:') || comma === -1) {
    throw new Error('dataUrlToFile: not a data URL')
  }
  const head = dataUrl.slice(0, comma)
  const mime = /^data:([^;,]+)/.exec(head)?.[1] || 'application/octet-stream'
  const payload = dataUrl.slice(comma + 1)
  if (/;base64$/i.test(head)) {
    const bin = atob(payload)
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    return new File([bytes], filename, { type: mime })
  }
  return new File([decodeURIComponent(payload)], filename, { type: mime })
}
