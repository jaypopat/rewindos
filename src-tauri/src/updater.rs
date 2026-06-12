//! In-app self-update: checks GitHub Releases and reimplements
//! install.sh's --update flow in Rust. Keep the file layout in sync
//! with install.sh's place_files().

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

pub const REPO: &str = "jaypopat/rewindos";
const TARBALL_NAME: &str = "rewindos-linux-x86_64.tar.gz";

#[derive(Debug, Deserialize)]
struct GhAsset {
    name: String,
    browser_download_url: String,
}

#[derive(Debug, Deserialize)]
struct GhRelease {
    tag_name: String,
    body: Option<String>,
    assets: Vec<GhAsset>,
}

#[derive(Debug, Clone)]
pub struct ReleaseInfo {
    pub tag: String,
    pub notes: String,
    pub tarball_url: String,
    pub sha_url: String,
}

pub fn parse_latest_release(json: &str) -> Result<ReleaseInfo, String> {
    let release: GhRelease =
        serde_json::from_str(json).map_err(|e| format!("release JSON: {e}"))?;
    let url_of = |name: &str| {
        release
            .assets
            .iter()
            .find(|a| a.name == name)
            .map(|a| a.browser_download_url.clone())
            .ok_or_else(|| format!("release {} has no asset {name}", release.tag_name))
    };
    Ok(ReleaseInfo {
        tarball_url: url_of(TARBALL_NAME)?,
        sha_url: url_of(&format!("{TARBALL_NAME}.sha256"))?,
        tag: release.tag_name,
        notes: release.body.unwrap_or_default(),
    })
}

/// `sha_file_contents` is sha256sum output: "<hex>  <filename>".
pub fn verify_sha256(file: &Path, sha_file_contents: &str) -> Result<(), String> {
    use sha2::{Digest, Sha256};
    let expected = sha_file_contents
        .split_whitespace()
        .next()
        .ok_or("empty sha256 file")?
        .to_lowercase();
    let bytes = std::fs::read(file).map_err(|e| format!("read {}: {e}", file.display()))?;
    let actual = format!("{:x}", Sha256::digest(&bytes));
    if actual == expected {
        Ok(())
    } else {
        Err(format!("checksum mismatch: expected {expected}, got {actual}"))
    }
}

fn rewrite_exec(desktop_contents: &str, exec: &str) -> String {
    let mut out: String = desktop_contents
        .lines()
        .map(|l| {
            if l.starts_with("Exec=") {
                format!("Exec={exec}")
            } else {
                l.to_string()
            }
        })
        .collect::<Vec<_>>()
        .join("\n");
    out.push('\n');
    out
}

/// True when `latest_tag` (optionally v-prefixed) is a strictly newer semver
/// than `current`. Unparseable versions are never "newer" — a malformed tag
/// must not trigger an update offer.
pub fn is_newer(latest_tag: &str, current: &str) -> bool {
    let latest = semver::Version::parse(latest_tag.trim_start_matches('v'));
    let current = semver::Version::parse(current.trim_start_matches('v'));
    matches!((latest, current), (Ok(l), Ok(c)) if l > c)
}

/// install_update is NOT re-entrant: concurrent runs would interleave the
/// .old rotation and could destroy the only good copy of a binary.
static INSTALL_IN_FLIGHT: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

struct ClearOnDrop;
impl Drop for ClearOnDrop {
    fn drop(&mut self) {
        INSTALL_IN_FLIGHT.store(false, std::sync::atomic::Ordering::Release);
    }
}

/// Every path and external command the updater touches, injectable for tests.
/// Mirrors the variables at the top of install.sh.
#[derive(Debug, Clone)]
pub struct UpdaterEnv {
    pub api_base: String,
    pub bin_dir: PathBuf,
    pub app_dir: PathBuf,
    pub icon_base: PathBuf,
    pub unit_dir: PathBuf,
    pub autostart_dir: PathBuf,
    pub share_dir: PathBuf,
    pub version_file: PathBuf,
    pub daemon_reload_cmd: Vec<String>,
    pub daemon_restart_cmd: Vec<String>,
}

impl Default for UpdaterEnv {
    fn default() -> Self {
        let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("/"));
        Self {
            api_base: "https://api.github.com".into(),
            bin_dir: home.join(".local/bin"),
            app_dir: home.join(".local/share/applications"),
            icon_base: home.join(".local/share/icons/hicolor"),
            unit_dir: home.join(".config/systemd/user"),
            autostart_dir: home.join(".config/autostart"),
            share_dir: home.join(".local/share/rewindos"),
            version_file: home.join(".rewindos/INSTALLED_VERSION"),
            daemon_reload_cmd: vec!["systemctl".into(), "--user".into(), "daemon-reload".into()],
            daemon_restart_cmd: vec![
                "systemctl".into(),
                "--user".into(),
                "restart".into(),
                "rewindos-daemon.service".into(),
            ],
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum InstallKind {
    /// install.sh / in-app updater install in ~/.local/bin — self-update allowed.
    Script,
    /// Distro package (AUR, deb, rpm) under /usr — the package manager owns updates.
    Packaged,
    /// Built from source (incl. dev builds) — user rebuilds to update.
    Source,
}

/// Classify how this binary was installed from its on-disk location.
/// `exe = None` (current_exe() failed) falls back to Source: never offer a
/// self-update we can't reason about.
pub fn classify_install(exe: Option<&Path>, env: &UpdaterEnv) -> InstallKind {
    let Some(exe) = exe else { return InstallKind::Source };
    if exe.starts_with(&env.bin_dir) && env.version_file.exists() {
        InstallKind::Script
    } else if exe.starts_with("/usr") {
        InstallKind::Packaged
    } else {
        InstallKind::Source
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct UpdateStatus {
    pub current: String,
    pub latest: String,
    pub release_notes: String,
    /// latest > current
    pub available: bool,
    /// How this binary was installed; drives which update path the UI offers.
    pub install_kind: InstallKind,
}

pub fn build_update_status(
    release: &ReleaseInfo,
    current: &str,
    install_kind: InstallKind,
) -> UpdateStatus {
    UpdateStatus {
        current: current.to_string(),
        latest: release.tag.clone(),
        release_notes: release.notes.clone(),
        available: is_newer(&release.tag, current),
        install_kind,
    }
}

async fn fetch_latest_release(env: &UpdaterEnv) -> Result<ReleaseInfo, String> {
    let client = reqwest::Client::builder()
        .user_agent("rewindos-updater") // GitHub API rejects UA-less requests
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| format!("http client: {e}"))?;
    let json = client
        .get(format!("{}/repos/{REPO}/releases/latest", env.api_base))
        .send()
        .await
        .map_err(|e| format!("releases API: {e}"))?
        .error_for_status()
        .map_err(|e| format!("releases API: {e}"))?
        .text()
        .await
        .map_err(|e| format!("releases API body: {e}"))?;
    parse_latest_release(&json)
}

const APP_ID: &str = "io.github.jaypopat.rewindos";
const BINARIES: [&str; 2] = ["rewindos", "rewindos-daemon"];
/// hicolor size dir -> filename inside the tarball's icons/ (from install.sh).
const ICONS: [(&str, &str); 4] = [
    ("32x32", "32x32.png"),
    ("128x128", "128x128.png"),
    ("256x256", "128x128@2x.png"),
    ("512x512", "icon.png"),
];

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "stage", rename_all = "snake_case")]
pub enum UpdateProgress {
    Downloading { pct: u8 },
    Verifying,
    Installing,
    RestartingDaemon,
    Done,
    Error { message: String },
}

fn run_cmd(cmd: &[String]) -> Result<(), String> {
    let (prog, args) = cmd.split_first().ok_or("empty command")?;
    let status = std::process::Command::new(prog)
        .args(args)
        .status()
        .map_err(|e| format!("spawn {prog}: {e}"))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("{} failed ({status})", cmd.join(" ")))
    }
}

/// fs::rename breaks across filesystems (staging is in /tmp, home may not be),
/// so place files by copy + chmod.
fn place(src: &Path, dst: &Path, mode: u32) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::copy(src, dst).map_err(|e| format!("copy to {}: {e}", dst.display()))?;
    std::fs::set_permissions(dst, std::fs::Permissions::from_mode(mode))
        .map_err(|e| format!("chmod {}: {e}", dst.display()))
}

fn smoke_check(stage: &Path) -> Result<(), String> {
    let daemon = stage.join("rewindos-daemon");
    let ok = std::process::Command::new(&daemon)
        .arg("--version")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false);
    if ok {
        Ok(())
    } else {
        Err("the new binary won't run on this system (likely too old a glibc/webkit). \
             Build from source instead — see the README."
            .into())
    }
}

fn rollback(env: &UpdaterEnv) -> Result<(), String> {
    let mut errors: Vec<String> = Vec::new();
    for name in BINARIES {
        let old = env.bin_dir.join(format!("{name}.old"));
        if old.exists() {
            if let Err(e) = std::fs::rename(&old, env.bin_dir.join(name)) {
                errors.push(format!("restore {name}: {e}"));
            }
        }
    }
    // Attempt daemon restart regardless of rename failures.
    if let Err(e) = run_cmd(&env.daemon_restart_cmd) {
        errors.push(format!("restart daemon: {e}"));
    }
    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors.join("; "))
    }
}

/// Swap an extracted release (stage = the rewindos-linux-x86_64/ dir) into
/// place. Mirrors install.sh place_files() + smoke_check(). Nothing on disk
/// changes unless the smoke check passes. On failure the two binaries are
/// rotated back; the unit file, desktop files, icons, and worker are
/// overwritten in place and NOT rolled back — they are version-tolerant
/// assets. A failed daemon restart also rolls back the two binaries.
pub fn apply_update(
    stage: &Path,
    env: &UpdaterEnv,
    tag: &str,
    progress: &dyn Fn(UpdateProgress),
) -> Result<(), String> {
    smoke_check(stage)?;
    progress(UpdateProgress::Installing);

    let version_dir = env
        .version_file
        .parent()
        .unwrap_or(Path::new("/"))
        .to_path_buf();
    let dirs = [
        env.bin_dir.clone(),
        env.app_dir.clone(),
        env.unit_dir.clone(),
        env.autostart_dir.clone(),
        env.share_dir.clone(),
        version_dir,
    ];
    for dir in &dirs {
        std::fs::create_dir_all(dir).map_err(|e| format!("mkdir {}: {e}", dir.display()))?;
    }

    // Rotate current binaries aside, then place the new ones.
    for name in BINARIES {
        let bin = env.bin_dir.join(name);
        let old = env.bin_dir.join(format!("{name}.old"));
        let _ = std::fs::remove_file(&old);
        if bin.exists() {
            std::fs::rename(&bin, &old).map_err(|e| format!("stash {name}: {e}"))?;
        }
    }
    let placed: Result<(), String> = (|| {
        for name in BINARIES {
            place(&stage.join(name), &env.bin_dir.join(name), 0o755)?;
        }
        place(
            &stage.join("rewindos-daemon.service"),
            &env.unit_dir.join("rewindos-daemon.service"),
            0o644,
        )?;
        place(
            &stage.join("paddleocr_worker.py"),
            &env.share_dir.join("paddleocr_worker.py"),
            0o644,
        )?;

        let app_exec = format!("{} --minimized", env.bin_dir.join("rewindos").display());
        let launcher = std::fs::read_to_string(stage.join("rewindos.desktop"))
            .map_err(|e| format!("read rewindos.desktop: {e}"))?;
        let launcher = rewrite_exec(&launcher, &app_exec);
        std::fs::write(env.app_dir.join(format!("{APP_ID}.desktop")), &launcher)
            .map_err(|e| format!("write launcher: {e}"))?;
        std::fs::write(env.autostart_dir.join("rewindos.desktop"), &launcher)
            .map_err(|e| format!("write autostart: {e}"))?;

        let daemon_desktop = std::fs::read_to_string(stage.join("com.rewindos.Daemon.desktop"))
            .map_err(|e| format!("read daemon desktop: {e}"))?;
        let daemon_desktop = rewrite_exec(
            &daemon_desktop,
            &env.bin_dir.join("rewindos-daemon").display().to_string(),
        );
        std::fs::write(env.app_dir.join("com.rewindos.Daemon.desktop"), daemon_desktop)
            .map_err(|e| format!("write daemon desktop: {e}"))?;

        for (size, file) in ICONS {
            let dst_dir = env.icon_base.join(size).join("apps");
            std::fs::create_dir_all(&dst_dir)
                .map_err(|e| format!("mkdir icons: {e}"))?;
            place(
                &stage.join("icons").join(file),
                &dst_dir.join(format!("{APP_ID}.png")),
                0o644,
            )?;
        }

        std::fs::write(&env.version_file, format!("{tag}\n"))
            .map_err(|e| format!("write INSTALLED_VERSION: {e}"))?;
        Ok(())
    })();
    if let Err(e) = placed {
        return Err(match rollback(env) {
            Ok(()) => e,
            Err(rb) => format!("{e}; rollback also failed ({rb}) — your install may be broken, re-run install.sh"),
        });
    }

    progress(UpdateProgress::RestartingDaemon);
    // Reload is best-effort: a stale unit cache is harmless here because the
    // restart below re-reads the unit file.  Restart failure DOES roll back.
    let _ = run_cmd(&env.daemon_reload_cmd);
    if let Err(e) = run_cmd(&env.daemon_restart_cmd) {
        return Err(match rollback(env) {
            Ok(()) => format!("daemon restart failed, previous version restored: {e}"),
            Err(rb) => format!("daemon restart failed ({e}); rollback also failed ({rb}) — your install may be broken, re-run install.sh"),
        });
    }

    for name in BINARIES {
        let _ = std::fs::remove_file(env.bin_dir.join(format!("{name}.old")));
    }
    Ok(())
}

#[tauri::command]
pub async fn check_for_update(app: tauri::AppHandle) -> Result<UpdateStatus, String> {
    let env = UpdaterEnv::default();
    let current = app.package_info().version.to_string();
    let release = fetch_latest_release(&env).await?;
    let kind = classify_install(std::env::current_exe().ok().as_deref(), &env);
    Ok(build_update_status(&release, &current, kind))
}

async fn download_with_progress<F>(
    client: &reqwest::Client,
    url: &str,
    dest: &Path,
    progress: &F,
) -> Result<(), String>
where
    F: Fn(UpdateProgress),
{
    use futures::StreamExt;
    let resp = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("download: {e}"))?
        .error_for_status()
        .map_err(|e| format!("download: {e}"))?;
    let total = resp.content_length().unwrap_or(0);
    let mut file = std::fs::File::create(dest).map_err(|e| format!("create tmp: {e}"))?;
    let mut stream = resp.bytes_stream();
    let mut written: u64 = 0;
    let mut last_pct: u8 = 0;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("download stream: {e}"))?;
        std::io::Write::write_all(&mut file, &chunk).map_err(|e| format!("write tmp: {e}"))?;
        written += chunk.len() as u64;
        if total > 0 {
            let pct = ((written * 100) / total) as u8;
            if pct != last_pct {
                last_pct = pct;
                progress(UpdateProgress::Downloading { pct });
            }
        }
    }
    Ok(())
}

async fn run_install<F>(env: UpdaterEnv, progress: F) -> Result<(), String>
where
    F: Fn(UpdateProgress) + Send + Sync + 'static,
{
    // No overall timeout: the tarball download is long on slow links.
    // connect_timeout still bounds a dead server.
    let client = reqwest::Client::builder()
        .user_agent("rewindos-updater")
        .connect_timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| format!("http client: {e}"))?;
    let release = fetch_latest_release(&env).await?;

    // tempdir is cleaned up on drop, on every exit path
    let staging = tempfile::tempdir().map_err(|e| format!("staging dir: {e}"))?;
    let tarball = staging.path().join(TARBALL_NAME);

    progress(UpdateProgress::Downloading { pct: 0 });
    download_with_progress(&client, &release.tarball_url, &tarball, &progress).await?;

    progress(UpdateProgress::Verifying);
    let sha = client
        .get(&release.sha_url)
        .send()
        .await
        .map_err(|e| format!("sha download: {e}"))?
        .error_for_status()
        .map_err(|e| format!("sha download: {e}"))?
        .text()
        .await
        .map_err(|e| format!("sha body: {e}"))?;

    // Everything from here is blocking fs/process work.
    // Move only the PathBuf into the closure; the TempDir stays in this
    // scope so it is not dropped until after spawn_blocking completes.
    let stage_root = staging.path().to_path_buf();
    let tag = release.tag.clone();
    let result = tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        verify_sha256(&tarball, &sha)?;
        let gz = std::fs::File::open(&tarball).map_err(|e| format!("open tarball: {e}"))?;
        tar::Archive::new(flate2::read::GzDecoder::new(gz))
            .unpack(&stage_root)
            .map_err(|e| format!("extract: {e}"))?;
        let stage = stage_root.join("rewindos-linux-x86_64");
        apply_update(&stage, &env, &tag, &progress)?;
        progress(UpdateProgress::Done);
        Ok(())
    })
    .await
    .map_err(|e| format!("install task: {e}"))?;
    drop(staging);
    result
}

#[tauri::command]
pub async fn install_update(app: tauri::AppHandle) -> Result<(), String> {
    use tauri::Emitter;
    if INSTALL_IN_FLIGHT
        .compare_exchange(
            false,
            true,
            std::sync::atomic::Ordering::AcqRel,
            std::sync::atomic::Ordering::Acquire,
        )
        .is_err()
    {
        return Err("an update is already in progress".into());
    }
    let _guard = ClearOnDrop;
    let env = UpdaterEnv::default();
    let kind = classify_install(std::env::current_exe().ok().as_deref(), &env);
    if kind != InstallKind::Script {
        return Err("self-update is only available for script installs".into());
    }
    let emitter = app.clone();
    let progress = move |p: UpdateProgress| {
        let _ = emitter.emit("update-progress", &p);
    };
    let result = run_install(env, progress).await;
    if let Err(ref e) = result {
        let _ = app.emit("update-progress", &UpdateProgress::Error { message: e.clone() });
    }
    result
}

/// Restart the application by exec-ing a new process.
///
/// `app.restart()` never returns — it replaces the current process image
/// immediately. As a result, the frontend `invoke` promise for this command
/// will never resolve. Callers must treat this as fire-and-forget and must
/// not `await` it expecting a response.
#[tauri::command]
pub fn restart_app(app: tauri::AppHandle) {
    app.restart();
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::{Path, PathBuf};

    const SAMPLE_RELEASE: &str = r###"{
        "tag_name": "v1.0.9",
        "body": "## What's Changed\n* fix stuff",
        "assets": [
            {"name": "rewindos-linux-x86_64.tar.gz",
             "browser_download_url": "https://example.com/rewindos-linux-x86_64.tar.gz"},
            {"name": "rewindos-linux-x86_64.tar.gz.sha256",
             "browser_download_url": "https://example.com/rewindos-linux-x86_64.tar.gz.sha256"}
        ]
    }"###;

    #[test]
    fn parses_release_json() {
        let r = parse_latest_release(SAMPLE_RELEASE).unwrap();
        assert_eq!(r.tag, "v1.0.9");
        assert!(r.notes.contains("fix stuff"));
        assert!(r.tarball_url.ends_with(".tar.gz"));
        assert!(r.sha_url.ends_with(".sha256"));
    }

    #[test]
    fn release_missing_asset_is_an_error() {
        let json = r#"{"tag_name": "v1.0.9", "body": null, "assets": []}"#;
        assert!(parse_latest_release(json).is_err());
    }

    #[test]
    fn sha256_verification() {
        let dir = tempfile::tempdir().unwrap();
        let f = dir.path().join("blob");
        std::fs::write(&f, b"hello").unwrap();
        // sha256("hello")
        let good = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824  blob\n";
        assert!(verify_sha256(&f, good).is_ok());
        let bad = "0000000000000000000000000000000000000000000000000000000000000000  blob\n";
        assert!(verify_sha256(&f, bad).is_err());
        assert!(verify_sha256(&f, "").is_err());
    }

    #[test]
    fn rewrites_exec_line_only() {
        let desktop = "[Desktop Entry]\nName=RewindOS\nExec=rewindos\nType=Application\n";
        let out = rewrite_exec(desktop, "/home/u/.local/bin/rewindos --minimized");
        assert!(out.contains("Exec=/home/u/.local/bin/rewindos --minimized"));
        assert!(out.contains("Name=RewindOS"));
        assert!(!out.contains("Exec=rewindos\n"));
    }

    #[test]
    fn is_newer_basic() {
        assert!(is_newer("v1.0.9", "1.0.8"));
        assert!(is_newer("1.1.0", "1.0.9"));
        assert!(!is_newer("v1.0.8", "1.0.8"));
        assert!(!is_newer("v1.0.7", "1.0.8"));
    }

    #[test]
    fn is_newer_garbage_is_never_newer() {
        assert!(!is_newer("not-a-version", "1.0.8"));
        assert!(!is_newer("v1.0.9", "garbage"));
        assert!(!is_newer("", ""));
    }

    fn sample_release() -> ReleaseInfo {
        ReleaseInfo {
            tag: "v1.0.9".into(),
            notes: "notes".into(),
            tarball_url: "u".into(),
            sha_url: "s".into(),
        }
    }

    #[test]
    fn classify_script_install() {
        let tmp = tempfile::tempdir().unwrap();
        let env = test_env(tmp.path(), true);
        std::fs::create_dir_all(env.version_file.parent().unwrap()).unwrap();
        std::fs::write(&env.version_file, "v1.0.9\n").unwrap();
        let exe = env.bin_dir.join("rewindos");
        assert_eq!(classify_install(Some(&exe), &env), InstallKind::Script);
    }

    #[test]
    fn classify_script_path_without_version_file_is_source() {
        let tmp = tempfile::tempdir().unwrap();
        let env = test_env(tmp.path(), true);
        let exe = env.bin_dir.join("rewindos");
        assert_eq!(classify_install(Some(&exe), &env), InstallKind::Source);
    }

    #[test]
    fn classify_usr_is_packaged() {
        let tmp = tempfile::tempdir().unwrap();
        let env = test_env(tmp.path(), true);
        assert_eq!(
            classify_install(Some(Path::new("/usr/bin/rewindos")), &env),
            InstallKind::Packaged
        );
        assert_eq!(
            classify_install(Some(Path::new("/usr/lib/rewindos/rewindos")), &env),
            InstallKind::Packaged
        );
    }

    #[test]
    fn classify_dev_or_unknown_is_source() {
        let tmp = tempfile::tempdir().unwrap();
        let env = test_env(tmp.path(), true);
        assert_eq!(
            classify_install(Some(Path::new("/home/u/dev/target/debug/rewindos")), &env),
            InstallKind::Source
        );
        assert_eq!(classify_install(None, &env), InstallKind::Source);
    }

    #[test]
    fn status_carries_install_kind_and_availability() {
        let s = build_update_status(&sample_release(), "1.0.8", InstallKind::Script);
        assert!(s.available);
        assert_eq!(s.install_kind, InstallKind::Script);
        assert_eq!(s.current, "1.0.8");
        assert_eq!(s.latest, "v1.0.9");

        let s = build_update_status(&sample_release(), "1.0.9", InstallKind::Packaged);
        assert!(!s.available);
        assert_eq!(s.install_kind, InstallKind::Packaged);
    }

    #[test]
    fn install_kind_serializes_snake_case() {
        assert_eq!(serde_json::to_string(&InstallKind::Script).unwrap(), "\"script\"");
        assert_eq!(serde_json::to_string(&InstallKind::Packaged).unwrap(), "\"packaged\"");
        assert_eq!(serde_json::to_string(&InstallKind::Source).unwrap(), "\"source\"");
    }

    use std::os::unix::fs::PermissionsExt;

    /// Build a fake extracted-tarball stage dir. Binaries are shell scripts so
    /// the smoke check can really exec them.
    fn fake_stage(dir: &Path, daemon_exit_code: i32) -> PathBuf {
        let stage = dir.join("rewindos-linux-x86_64");
        std::fs::create_dir_all(stage.join("icons")).unwrap();
        let write_exec = |name: &str, body: &str| {
            let p = stage.join(name);
            std::fs::write(&p, body).unwrap();
            std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
        };
        write_exec("rewindos", "#!/bin/sh\nexit 0\n");
        write_exec(
            "rewindos-daemon",
            &format!("#!/bin/sh\nexit {daemon_exit_code}\n"),
        );
        std::fs::write(stage.join("rewindos-daemon.service"), "[Unit]\n").unwrap();
        std::fs::write(
            stage.join("rewindos.desktop"),
            "[Desktop Entry]\nExec=rewindos\n",
        )
        .unwrap();
        std::fs::write(
            stage.join("com.rewindos.Daemon.desktop"),
            "[Desktop Entry]\nExec=rewindos-daemon\n",
        )
        .unwrap();
        std::fs::write(stage.join("paddleocr_worker.py"), "# worker\n").unwrap();
        for icon in ["32x32.png", "128x128.png", "128x128@2x.png", "icon.png"] {
            std::fs::write(stage.join("icons").join(icon), b"png").unwrap();
        }
        stage
    }

    /// UpdaterEnv rooted in a temp dir; restart command injectable.
    fn test_env(root: &Path, restart_ok: bool) -> UpdaterEnv {
        UpdaterEnv {
            api_base: "http://unused".into(),
            bin_dir: root.join("bin"),
            app_dir: root.join("applications"),
            icon_base: root.join("icons"),
            unit_dir: root.join("systemd"),
            autostart_dir: root.join("autostart"),
            share_dir: root.join("share/rewindos"),
            version_file: root.join("data/INSTALLED_VERSION"),
            daemon_reload_cmd: vec!["true".into()],
            daemon_restart_cmd: vec![if restart_ok { "true" } else { "false" }.into()],
        }
    }

    fn install_old_binaries(env: &UpdaterEnv) {
        std::fs::create_dir_all(&env.bin_dir).unwrap();
        for name in ["rewindos", "rewindos-daemon"] {
            let p = env.bin_dir.join(name);
            std::fs::write(&p, "OLD").unwrap();
            std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
    }

    #[test]
    fn apply_update_happy_path() {
        let tmp = tempfile::tempdir().unwrap();
        let stage = fake_stage(tmp.path(), 0);
        let env = test_env(tmp.path(), true);
        install_old_binaries(&env);

        apply_update(&stage, &env, "v1.0.9", &|_| {}).unwrap();

        let new = std::fs::read_to_string(env.bin_dir.join("rewindos-daemon")).unwrap();
        assert!(new.contains("#!/bin/sh"), "binary was replaced");
        assert!(!env.bin_dir.join("rewindos.old").exists(), ".old cleaned up");
        assert_eq!(
            std::fs::read_to_string(&env.version_file).unwrap().trim(),
            "v1.0.9"
        );
        assert!(env.unit_dir.join("rewindos-daemon.service").exists());
        assert!(env.share_dir.join("paddleocr_worker.py").exists());
        let launcher = std::fs::read_to_string(
            env.app_dir.join("io.github.jaypopat.rewindos.desktop"),
        )
        .unwrap();
        assert!(launcher.contains(&format!(
            "Exec={} --minimized",
            env.bin_dir.join("rewindos").display()
        )));
        assert!(env.autostart_dir.join("rewindos.desktop").exists());
        assert!(env.icon_base.join("512x512/apps/io.github.jaypopat.rewindos.png").exists());
    }

    #[test]
    fn apply_update_smoke_check_failure_touches_nothing() {
        let tmp = tempfile::tempdir().unwrap();
        let stage = fake_stage(tmp.path(), 1); // new daemon won't run
        let env = test_env(tmp.path(), true);
        install_old_binaries(&env);

        let err = apply_update(&stage, &env, "v1.0.9", &|_| {}).unwrap_err();
        assert!(err.contains("won't run"), "got: {err}");
        assert_eq!(
            std::fs::read_to_string(env.bin_dir.join("rewindos")).unwrap(),
            "OLD"
        );
        assert!(!env.version_file.exists());
    }

    #[test]
    fn apply_update_restart_failure_rolls_back() {
        let tmp = tempfile::tempdir().unwrap();
        let stage = fake_stage(tmp.path(), 0);
        let env = test_env(tmp.path(), false); // daemon restart fails
        install_old_binaries(&env);

        assert!(apply_update(&stage, &env, "v1.0.9", &|_| {}).is_err());
        assert_eq!(
            std::fs::read_to_string(env.bin_dir.join("rewindos")).unwrap(),
            "OLD",
            "old binaries restored"
        );
        assert_eq!(
            std::fs::read_to_string(env.bin_dir.join("rewindos-daemon")).unwrap(),
            "OLD"
        );
    }

    #[test]
    fn apply_update_placement_failure_rolls_back_binaries() {
        let tmp = tempfile::tempdir().unwrap();
        let stage = fake_stage(tmp.path(), 0);
        let env = test_env(tmp.path(), true);
        install_old_binaries(&env);

        // Force placement failure: make icon_base a read-only directory so
        // the mkdir inside apply_update (icon_base/<size>/apps) fails with EACCES.
        std::fs::create_dir_all(&env.icon_base).unwrap();
        std::fs::set_permissions(
            &env.icon_base,
            std::fs::Permissions::from_mode(0o555),
        )
        .unwrap();

        let result = apply_update(&stage, &env, "v1.0.9", &|_| {});

        // Restore write permission before any assertions so tempdir cleanup works.
        std::fs::set_permissions(
            &env.icon_base,
            std::fs::Permissions::from_mode(0o755),
        )
        .unwrap();

        assert!(result.is_err(), "expected Err from placement failure");
        assert_eq!(
            std::fs::read_to_string(env.bin_dir.join("rewindos")).unwrap(),
            "OLD",
            "rewindos binary should be restored after placement failure"
        );
        assert_eq!(
            std::fs::read_to_string(env.bin_dir.join("rewindos-daemon")).unwrap(),
            "OLD",
            "rewindos-daemon binary should be restored after placement failure"
        );
    }
}
