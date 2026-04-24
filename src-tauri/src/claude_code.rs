use std::path::PathBuf;
use std::process::Stdio;
use tokio::process::Command;

#[derive(Debug, Clone, serde::Serialize)]
pub struct ClaudeCodeStatus {
    pub available: bool,
    pub path: Option<String>,
    pub mcp_registered: bool,
}

pub fn detect() -> ClaudeCodeStatus {
    let path = find_claude_binary();
    let available = path.is_some();
    let mcp_registered = is_mcp_registered();
    ClaudeCodeStatus {
        available,
        path: path.map(|p| p.to_string_lossy().into_owned()),
        mcp_registered,
    }
}

/// Resolve the `claude` CLI. Tries `$PATH` first (covers terminal launches),
/// then falls back to well-known install locations — desktop apps often
/// inherit a stripped PATH that doesn't include the user's `~/.local/bin`
/// or node global bins, even when `claude` is clearly installed.
fn find_claude_binary() -> Option<PathBuf> {
    if let Ok(p) = which::which("claude") {
        return Some(p);
    }
    let home = dirs::home_dir()?;
    let candidates = [
        home.join(".local/bin/claude"),
        home.join(".npm-global/bin/claude"),
        home.join(".bun/bin/claude"),
        home.join(".yarn/bin/claude"),
        home.join(".volta/bin/claude"),
    ];
    for c in &candidates {
        if c.is_file() {
            return Some(c.clone());
        }
    }
    // Try common node-version-manager paths (nvm, fnm) without glob crate
    let nvm_root = home.join(".nvm/versions/node");
    if let Ok(entries) = std::fs::read_dir(&nvm_root) {
        for e in entries.flatten() {
            let candidate = e.path().join("bin/claude");
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

fn is_mcp_registered() -> bool {
    let Some(home) = dirs::home_dir() else {
        return false;
    };
    let settings_path = home.join(".claude").join("settings.json");
    let Ok(contents) = std::fs::read_to_string(&settings_path) else {
        return false;
    };
    let Ok(json) = serde_json::from_str::<serde_json::Value>(&contents) else {
        return false;
    };
    json.get("mcpServers")
        .and_then(|m| m.get("rewindos"))
        .is_some()
}

pub fn register_mcp() -> Result<(), String> {
    let home = dirs::home_dir().ok_or_else(|| "no home dir".to_string())?;
    let settings_dir = home.join(".claude");
    std::fs::create_dir_all(&settings_dir).map_err(|e| format!("mkdir: {e}"))?;
    let settings_path = settings_dir.join("settings.json");

    let mut json: serde_json::Value = if settings_path.exists() {
        let contents =
            std::fs::read_to_string(&settings_path).map_err(|e| format!("read: {e}"))?;
        if contents.trim().is_empty() {
            serde_json::json!({})
        } else {
            serde_json::from_str(&contents).map_err(|e| format!("parse: {e}"))?
        }
    } else {
        serde_json::json!({})
    };

    let daemon_path = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.join("rewindos-daemon")))
        .filter(|p| p.exists())
        .or_else(|| which::which("rewindos-daemon").ok())
        .ok_or_else(|| "rewindos-daemon binary not found".to_string())?;

    let entry = serde_json::json!({
        "command": daemon_path.to_string_lossy(),
        "args": ["mcp"]
    });

    json.as_object_mut()
        .ok_or_else(|| "settings.json root must be an object".to_string())?
        .entry("mcpServers")
        .or_insert_with(|| serde_json::json!({}))
        .as_object_mut()
        .ok_or_else(|| "mcpServers must be an object".to_string())?
        .insert("rewindos".to_string(), entry);

    let pretty = serde_json::to_string_pretty(&json).map_err(|e| format!("serialize: {e}"))?;
    std::fs::write(&settings_path, pretty).map_err(|e| format!("write: {e}"))?;
    Ok(())
}

pub async fn ask_claude_stream_spawn(
    prompt: &str,
    system_prompt: &str,
    session_id: Option<&str>,
    resume: bool,
) -> Result<tokio::process::Child, String> {
    let binary = find_claude_binary().ok_or_else(|| "claude CLI not found".to_string())?;
    let mut cmd = Command::new(&binary);
    cmd.arg("-p")
        .arg(prompt)
        .arg("--output-format")
        .arg("stream-json")
        .arg("--verbose")
        .arg("--append-system-prompt")
        .arg(system_prompt);

    if let Some(sid) = session_id {
        if resume {
            cmd.arg("--resume").arg(sid);
        } else {
            cmd.arg("--session-id").arg(sid);
        }
    }

    cmd.stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("spawn claude: {e}"))
}
