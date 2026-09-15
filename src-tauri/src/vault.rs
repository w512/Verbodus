// Recovery helper for the Stronghold vault that stores API keys.
//
// The vault is unlocked with a random per-install password kept in the
// WebView's localStorage (see src/store/secrets.js). If that password is lost
// (WebView data cleared, profile migrated) while the snapshot file survives,
// `Stronghold.load` fails forever and the app can neither read nor save keys.
// The frontend calls this to move the unreadable snapshot aside — never
// deleting it — so a fresh vault can be created in its place.

use std::time::{SystemTime, UNIX_EPOCH};
use tauri::Manager;

/// Must match the file name used by `initVault()` in src/store/secrets.js.
pub const VAULT_FILE: &str = "verbodus.vault";

/// Renames `<app_data_dir>/verbodus.vault` to `verbodus.vault.bak-<unix-ts>`.
/// Returns the backup path, or an empty string if there was nothing to move.
#[tauri::command]
pub fn backup_vault(app: tauri::AppHandle) -> Result<String, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Cannot resolve app data dir: {e}"))?;
    let vault = dir.join(VAULT_FILE);
    if !vault.exists() {
        return Ok(String::new());
    }
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let backup = dir.join(format!("{VAULT_FILE}.bak-{ts}"));
    std::fs::rename(&vault, &backup)
        .map_err(|e| format!("Cannot move vault aside ({}): {e}", vault.display()))?;
    Ok(backup.to_string_lossy().into_owned())
}
