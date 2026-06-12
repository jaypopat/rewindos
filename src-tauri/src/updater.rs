//! In-app self-update: checks GitHub Releases and reimplements
//! install.sh's --update flow in Rust. Keep the file layout in sync
//! with install.sh's place_files().

use std::path::Path;

use serde::Deserialize;

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

#[cfg(test)]
mod tests {
    use super::*;

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
}
