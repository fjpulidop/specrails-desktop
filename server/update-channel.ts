/**
 * Release channel shared by the app updater and the Core update check.
 *
 * - `latest` (default): the newest published release — the historical behaviour.
 * - `stable`: a release explicitly promoted by `.github/workflows/promote-stable.yml`
 *   after soaking on `latest` (≥ 7 days, green CI). For Core it pins the npm
 *   `stable` dist-tag and falls back to `latest` while Core publishes none.
 */
export type UpdateChannel = 'latest' | 'stable'

export const DEFAULT_UPDATE_CHANNEL: UpdateChannel = 'latest'

const RELEASES = 'https://github.com/fjpulidop/specrails-desktop/releases'

export function isUpdateChannel(value: unknown): value is UpdateChannel {
  return value === 'latest' || value === 'stable'
}

/** Settings value → channel; unknown or missing values read as the default. */
export function parseUpdateChannel(value: unknown): UpdateChannel {
  return isUpdateChannel(value) ? value : DEFAULT_UPDATE_CHANNEL
}

/** Tauri updater manifest per channel. Mirrors `src-tauri/src/app_updates.rs`. */
export function appUpdaterManifestUrl(channel: UpdateChannel): string {
  return channel === 'stable'
    ? `${RELEASES}/download/stable/latest.json`
    : `${RELEASES}/latest/download/latest.json`
}
