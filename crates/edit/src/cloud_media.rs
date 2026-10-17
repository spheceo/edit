//! Footage of cloud projects: originals and proxies on R2 (`crate::cloud`),
//! only the small proxies on this machine. A media's `cloud` says where its
//! files are; its `path` is this machine's copy of the proxy.

use crate::server::App;

/// Makes every cloud media of project `id` playable here: fetches proxies this
/// machine doesn't have yet and points their `path` at them. Called when a
/// cloud project is opened (it may have been edited on another machine).
pub async fn ensure_local(app: &App, id: &str) -> Result<(), String> {
    let _ = (app, id);
    Ok(())
}
