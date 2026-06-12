//! In-app self-update: checks GitHub Releases and reimplements
//! install.sh's --update flow in Rust. Keep the file layout in sync
//! with install.sh's place_files().

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
