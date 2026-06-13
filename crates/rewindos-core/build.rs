use std::path::Path;

// Single source of truth for the app version is src-tauri/tauri.conf.json (the
// release script bumps only that file). Inject it as REWINDOS_VERSION so every
// build — cargo, just, CI — reports the real version instead of the crate's
// placeholder 0.1.0. Falls back silently to CARGO_PKG_VERSION (see lib::VERSION)
// if the config can't be read.
fn main() {
    let conf = Path::new("../../src-tauri/tauri.conf.json");
    println!("cargo:rerun-if-changed=../../src-tauri/tauri.conf.json");
    if let Ok(text) = std::fs::read_to_string(conf) {
        if let Ok(json) = serde_json::from_str::<serde_json::Value>(&text) {
            if let Some(v) = json.get("version").and_then(|v| v.as_str()) {
                println!("cargo:rustc-env=REWINDOS_VERSION={v}");
            }
        }
    }
}
