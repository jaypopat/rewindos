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
    let path: Option<PathBuf> = which::which("claude").ok();
    let available = path.is_some();
    let mcp_registered = is_mcp_registered();
    ClaudeCodeStatus {
        available,
        path: path.map(|p| p.to_string_lossy().into_owned()),
        mcp_registered,
    }
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
    let mut cmd = Command::new("claude");
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
