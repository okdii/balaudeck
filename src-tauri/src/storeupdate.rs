//! Store-update check for builds distributed through a store (Mac App Store,
//! iOS App Store, Google Play), where the self-updater is compiled out and we
//! must not self-update. We can't replace the binary, but we can look up the
//! store's latest version and nudge the user to update via the store.
//!
//! iOS / macOS use Apple's public iTunes lookup API, which reports the version
//! actually LIVE on the store (so no false prompt while a build is still in
//! review). Android has no official lookup, so we reuse the GitHub `latest.json`
//! version — bumped in lockstep with every store release — as the source.
//!
//! Done Rust-side (reqwest, already a dep) so it isn't blocked by the webview's
//! CORS on the cross-origin store endpoints.

use serde::Serialize;

#[derive(Serialize)]
pub struct StoreUpdate {
    /// Latest version live on the store.
    pub version: String,
    /// Deep link that opens the store on this app's listing.
    pub url: String,
}

const BUNDLE_ID: &str = "com.okdii.balaudeck";
const LATEST_JSON: &str = "https://github.com/okdii/balaudeck/releases/latest/download/latest.json";
const PLAY_URL: &str = "https://play.google.com/store/apps/details?id=com.okdii.balaudeck";

/// Latest store version + a store deep link for `platform`
/// ("ios" | "macos" | "android"). Returns `None` on any error / unknown so a
/// flaky network never surfaces an error — the frontend just shows no prompt.
#[tauri::command]
pub async fn store_latest_version(platform: String) -> Result<Option<StoreUpdate>, String> {
    Ok(fetch(&platform).await.ok().flatten())
}

async fn fetch(platform: &str) -> Result<Option<StoreUpdate>, reqwest::Error> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()?;
    match platform {
        "ios" | "macos" => {
            // `macSoftware` selects the Mac App Store record when the bundle id
            // has both an iOS and a macOS app.
            let entity = if platform == "macos" { "macSoftware" } else { "software" };
            let url = format!("https://itunes.apple.com/lookup?bundleId={BUNDLE_ID}&entity={entity}");
            let j: serde_json::Value = client.get(url).send().await?.json().await?;
            let r = &j["results"][0];
            let track = r["trackViewUrl"].as_str().unwrap_or("");
            Ok(r["version"].as_str().map(|v| {
                // App-Store deep-link scheme so the tap opens the store app
                // directly rather than bouncing through the browser.
                let scheme = if platform == "ios" { "itms-apps://" } else { "macappstore://" };
                let url = if track.is_empty() {
                    track.to_string()
                } else {
                    track.replacen("https://", scheme, 1)
                };
                StoreUpdate { version: v.to_string(), url }
            }))
        }
        "android" => {
            let j: serde_json::Value = client.get(LATEST_JSON).send().await?.json().await?;
            Ok(j["version"].as_str().map(|v| StoreUpdate {
                version: v.to_string(),
                url: PLAY_URL.to_string(),
            }))
        }
        _ => Ok(None),
    }
}
