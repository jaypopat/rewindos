//! Meeting-scoped acoustic echo cancellation via PipeWire's echo-cancel module.
//!
//! Without it, the mic picks up the remote party's voice coming out of the
//! speakers, so transcript segments labeled "You" contain text the remote
//! person said. The module correlates the mic input with what is being played
//! and subtracts the echo, exposing a clean virtual source.
//!
//! Lifecycle (all best-effort, raw mic is the fallback):
//!   setup:    pactl load-module module-echo-cancel  → rewindos_ec_mic/_sink
//!             remember the default sink, switch it to rewindos_ec_sink so
//!             meeting audio routes through the canceller (WirePlumber moves
//!             running streams to the new default automatically)
//!   capture:  mic from `rewindos_ec_mic`; system capture still records the
//!             default-sink monitor, which is now the EC sink — same content
//!   teardown: restore the previous default sink, unload the module

use std::process::Command;

use tracing::{info, warn};

/// `node.name` of the echo-cancelled source the module exposes.
pub const EC_SOURCE: &str = "rewindos_ec_mic";
/// `node.name` of the echo-cancel playback sink.
pub const EC_SINK: &str = "rewindos_ec_sink";

/// Build the `pactl load-module` argv. `mic_master` pins the canceller to a
/// specific physical mic (the user's configured `mic_source`); empty/None uses
/// the default source.
fn load_module_args(mic_master: Option<&str>) -> Vec<String> {
    let mut args = vec![
        "load-module".to_string(),
        "module-echo-cancel".to_string(),
        format!("source_name={EC_SOURCE}"),
        format!("sink_name={EC_SINK}"),
    ];
    if let Some(m) = mic_master {
        if !m.is_empty() {
            args.push(format!("source_master={m}"));
        }
    }
    args
}

fn pactl(args: &[&str]) -> Result<String, String> {
    let out = Command::new("pactl")
        .args(args)
        .output()
        .map_err(|e| format!("pactl: {e}"))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// Owns one loaded echo-cancel module instance + the default-sink switch.
pub struct EchoCancelGuard {
    module_id: String,
    prev_default_sink: Option<String>,
}

impl EchoCancelGuard {
    /// Load the module and route the default sink through it. Returns `Err`
    /// when anything fails; the caller then records from the raw mic.
    pub fn setup(mic_master: Option<&str>) -> Result<Self, String> {
        // A crashed previous run can leave our module loaded; reuse it (we
        // recognize it by our source name) rather than stacking another.
        let module_id = match find_existing_module() {
            Some(id) => {
                info!(module_id = %id, "reusing leftover echo-cancel module");
                id
            }
            None => {
                let args = load_module_args(mic_master);
                let argv: Vec<&str> = args.iter().map(String::as_str).collect();
                pactl(&argv).map_err(|e| format!("load echo-cancel module: {e}"))?
            }
        };

        let prev_default_sink = pactl(&["get-default-sink"]).ok();
        if let Err(e) = pactl(&["set-default-sink", EC_SINK]) {
            // Without the sink switch the canceller gets no reference signal,
            // so it cannot cancel anything — undo and report failure.
            let _ = pactl(&["unload-module", &module_id]);
            return Err(format!("switch default sink to {EC_SINK}: {e}"));
        }
        info!(module_id = %module_id, "echo-cancel active for meeting capture");
        Ok(Self {
            module_id,
            prev_default_sink,
        })
    }

    /// Restore the previous default sink and unload the module. Best-effort.
    pub fn teardown(self) {
        if let Some(prev) = &self.prev_default_sink {
            if let Err(e) = pactl(&["set-default-sink", prev]) {
                warn!(error = %e, "echo-cancel: failed to restore default sink");
            }
        }
        if let Err(e) = pactl(&["unload-module", &self.module_id]) {
            warn!(error = %e, "echo-cancel: failed to unload module");
        }
    }
}

/// Find a leftover echo-cancel module from a previous run by our source name.
fn find_existing_module() -> Option<String> {
    let list = pactl(&["list", "short", "modules"]).ok()?;
    list.lines()
        .find(|l| l.contains("module-echo-cancel") && l.contains(EC_SOURCE))
        .and_then(|l| l.split_whitespace().next())
        .map(str::to_string)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn load_module_args_pin_master_only_when_set() {
        let base = load_module_args(None);
        assert_eq!(
            base,
            vec![
                "load-module",
                "module-echo-cancel",
                "source_name=rewindos_ec_mic",
                "sink_name=rewindos_ec_sink",
            ]
        );
        assert_eq!(load_module_args(Some("")), base, "empty master = default");
        let pinned = load_module_args(Some("alsa_input.pci-0000_65_00.6.analog-stereo"));
        assert_eq!(
            pinned.last().unwrap(),
            "source_master=alsa_input.pci-0000_65_00.6.analog-stereo"
        );
    }
}
