//! Channel-aware app update check.
//!
//! `tauri.conf.json` compiles a single updater endpoint (the `latest` channel).
//! This command rebuilds the updater with the endpoint of the channel selected in
//! App settings ▸ Updates and returns the same metadata shape as the plugin's own
//! `check`, registering the `Update` in the webview resource table so the JS
//! `Update` class can download/install it through the stock plugin commands
//! (signature verification is unchanged: the configured pubkey still applies).
//! Keep the URLs in sync with `server/update-channel.ts`.
use serde::Serialize;
use tauri::{Manager, Runtime, Url, Webview};
use tauri_plugin_updater::UpdaterExt;

const LATEST_MANIFEST: &str =
    "https://github.com/fjpulidop/specrails-desktop/releases/latest/download/latest.json";
/// Asset on the moving `stable` pre-release maintained by `promote-stable.yml`.
const STABLE_MANIFEST: &str =
    "https://github.com/fjpulidop/specrails-desktop/releases/download/stable/latest.json";

pub const STABLE_UNAVAILABLE: &str = "stable-channel-unavailable";

/// Updater manifest for a channel; unknown channels are rejected, never widened.
pub fn manifest_url(channel: &str) -> Result<&'static str, String> {
    match channel {
        "latest" => Ok(LATEST_MANIFEST),
        "stable" => Ok(STABLE_MANIFEST),
        other => Err(format!("Unknown update channel \"{other}\"")),
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateMetadata {
    rid: tauri::ResourceId,
    current_version: String,
    version: String,
    date: Option<String>,
    body: Option<String>,
    raw_json: serde_json::Value,
}

#[tauri::command]
pub async fn check_app_update<R: Runtime>(webview: Webview<R>, channel: String) -> Result<Option<UpdateMetadata>, String> {
    let endpoint = Url::parse(manifest_url(&channel)?).map_err(|e| e.to_string())?;
    let updater = webview
        .updater_builder()
        .endpoints(vec![endpoint])
        .map_err(|e| e.to_string())?
        .build()
        .map_err(|e| e.to_string())?;
    let update = match updater.check().await {
        Ok(update) => update,
        // A stable channel without a promoted release answers 404 — say so
        // instead of silently switching the user to `latest`.
        Err(tauri_plugin_updater::Error::ReleaseNotFound) if channel == "stable" => {
            return Err(STABLE_UNAVAILABLE.into())
        }
        Err(error) => return Err(error.to_string()),
    };
    Ok(update.map(|update| UpdateMetadata {
        current_version: update.current_version.clone(),
        version: update.version.clone(),
        date: update.raw_json.get("pub_date").and_then(|v| v.as_str()).map(str::to_owned),
        body: update.body.clone(),
        raw_json: update.raw_json.clone(),
        rid: webview.resources_table().add(update),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn channels_map_to_their_manifest_and_unknown_channels_fail() {
        assert_eq!(manifest_url("latest").unwrap(), LATEST_MANIFEST);
        assert_eq!(manifest_url("stable").unwrap(), STABLE_MANIFEST);
        assert!(manifest_url("beta").is_err());
        assert!(manifest_url("").is_err());
    }

    #[test]
    fn latest_matches_the_compiled_updater_endpoint() {
        let config: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert_eq!(config["plugins"]["updater"]["endpoints"][0], LATEST_MANIFEST);
    }
}
