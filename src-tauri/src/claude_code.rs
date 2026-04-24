use std::path::PathBuf;

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
