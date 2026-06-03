// All items below are consumed once the gate is wired into the pipeline and
// D-Bus service in Task 4. Until then they are intentionally unused.
#![allow(dead_code)]

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

use rewindos_core::config::PrivacyConfig;

use crate::window_info::WindowInfoProvider;

/// The reported capture state, derived from the gate's veto flags + frame timing.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CaptureState {
    Capturing,
    Stalled,
    PausedUser,
    PausedPrivacy,
    PausedLocked,
}

impl CaptureState {
    pub fn as_str(self) -> &'static str {
        match self {
            CaptureState::Capturing => "capturing",
            CaptureState::Stalled => "stalled",
            CaptureState::PausedUser => "paused_user",
            CaptureState::PausedPrivacy => "paused_privacy",
            CaptureState::PausedLocked => "paused_locked",
        }
    }

    /// Pure derivation. Displayed-label precedence is `locked > user > privacy`
    /// (a paused-then-locked session resumes-to-locked, so "locked" is the
    /// honest readout). `wants` is still stored separately and governs
    /// post-unlock behavior; this ordering only picks the emitted label.
    pub fn derive(
        wants: bool,
        privacy_blocked: bool,
        lock_blocked: bool,
        last_frame_at_ms: u64,
        now_ms: u64,
        stall_threshold_ms: u64,
    ) -> CaptureState {
        if lock_blocked {
            return CaptureState::PausedLocked;
        }
        if !wants {
            return CaptureState::PausedUser;
        }
        if privacy_blocked {
            return CaptureState::PausedPrivacy;
        }
        if last_frame_at_ms == 0 || now_ms.saturating_sub(last_frame_at_ms) > stall_threshold_ms {
            return CaptureState::Stalled;
        }
        CaptureState::Capturing
    }
}

/// Stall threshold in ms: 3x the capture interval, floored at 30s so a slow
/// first frame (or a small interval) never false-flags "stalled".
pub fn stall_threshold_ms(interval_secs: u32) -> u64 {
    (interval_secs as u64)
        .saturating_mul(3)
        .saturating_mul(1000)
        .max(30_000)
}

/// Three orthogonal veto inputs plus last-frame timing. The capture loop reads
/// `should_capture()`; the D-Bus service derives the reported `CaptureState`.
pub struct CaptureGate {
    wants_capture: AtomicBool,
    privacy_blocked: AtomicBool,
    lock_blocked: AtomicBool,
    last_frame_at: AtomicU64,
}

impl CaptureGate {
    pub fn new(wants: bool) -> Self {
        Self {
            wants_capture: AtomicBool::new(wants),
            privacy_blocked: AtomicBool::new(false),
            lock_blocked: AtomicBool::new(false),
            last_frame_at: AtomicU64::new(0),
        }
    }

    pub fn should_capture(&self) -> bool {
        self.wants_capture.load(Ordering::SeqCst)
            && !self.privacy_blocked.load(Ordering::SeqCst)
            && !self.lock_blocked.load(Ordering::SeqCst)
    }

    pub fn wants_capture(&self) -> bool {
        self.wants_capture.load(Ordering::SeqCst)
    }
    pub fn set_wants_capture(&self, v: bool) {
        self.wants_capture.store(v, Ordering::SeqCst);
    }
    pub fn privacy_blocked(&self) -> bool {
        self.privacy_blocked.load(Ordering::SeqCst)
    }
    pub fn set_privacy_blocked(&self, v: bool) {
        self.privacy_blocked.store(v, Ordering::SeqCst);
    }
    pub fn set_lock_blocked(&self, v: bool) {
        self.lock_blocked.store(v, Ordering::SeqCst);
    }
    pub fn lock_blocked(&self) -> bool {
        self.lock_blocked.load(Ordering::SeqCst)
    }
    pub fn last_frame_at(&self) -> u64 {
        self.last_frame_at.load(Ordering::Relaxed)
    }
    pub fn stamp_frame(&self, ts_ms: u64) {
        self.last_frame_at.store(ts_ms, Ordering::Relaxed);
    }

    /// Seconds since the last genuine frame. `None` when no frame has arrived
    /// yet (`last_frame_at == 0`) — never a sentinel large value.
    pub fn seconds_since_last_frame(&self, now_ms: u64) -> Option<u64> {
        let last = self.last_frame_at();
        if last == 0 {
            return None;
        }
        Some(now_ms.saturating_sub(last) / 1000)
    }

    /// Derive the reported state from the current flags + frame timing.
    pub fn capture_state(&self, now_ms: u64, interval_secs: u32) -> CaptureState {
        CaptureState::derive(
            self.wants_capture.load(Ordering::SeqCst),
            self.privacy_blocked.load(Ordering::SeqCst),
            self.lock_blocked.load(Ordering::SeqCst),
            self.last_frame_at(),
            now_ms,
            stall_threshold_ms(interval_secs),
        )
    }
}

/// Recompute the privacy veto: block capture when window metadata is not
/// reliable enough to enforce exclusions.
///
/// FAIL-CLOSED: a provider that cannot affirmatively confirm it produces real
/// metadata (`provides_reliable_metadata() == false`, including the trait
/// default for unmapped/forgotten providers) is treated as unsafe. This is the
/// OPPOSITE default from the lock watcher (which does NOT pause when it can't
/// detect lock). The asymmetry is intentional — see the capture-integrity spec.
/// Do not align the two.
pub fn recompute_privacy_gate(
    gate: &CaptureGate,
    provider: &dyn WindowInfoProvider,
    privacy: &PrivacyConfig,
    override_unfiltered: bool,
) {
    let exclusions_set =
        !privacy.excluded_apps.is_empty() || !privacy.excluded_title_patterns.is_empty();
    let blocked =
        !provider.provides_reliable_metadata() && exclusions_set && !override_unfiltered;
    gate.set_privacy_blocked(blocked);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::window_info::{WindowInfo, WindowInfoError, WindowInfoProvider};
    use async_trait::async_trait;

    // ---- derive() precedence: locked > user > privacy ----
    #[test]
    fn derive_capturing_when_all_clear_and_recent_frame() {
        let s = CaptureState::derive(true, false, false, 1_000, 1_500, 30_000);
        assert_eq!(s, CaptureState::Capturing);
    }

    #[test]
    fn derive_locked_beats_user_and_privacy() {
        // locked wins even if user also paused and privacy also blocked
        let s = CaptureState::derive(false, true, true, 1_000, 1_500, 30_000);
        assert_eq!(s, CaptureState::PausedLocked);
    }

    #[test]
    fn derive_user_beats_privacy() {
        let s = CaptureState::derive(false, true, false, 1_000, 1_500, 30_000);
        assert_eq!(s, CaptureState::PausedUser);
    }

    #[test]
    fn derive_privacy_when_only_privacy_blocked() {
        let s = CaptureState::derive(true, true, false, 1_000, 1_500, 30_000);
        assert_eq!(s, CaptureState::PausedPrivacy);
    }

    #[test]
    fn derive_stalled_when_frame_too_old() {
        let s = CaptureState::derive(true, false, false, 1_000, 1_000 + 30_001, 30_000);
        assert_eq!(s, CaptureState::Stalled);
    }

    #[test]
    fn derive_stalled_when_no_frame_yet() {
        let s = CaptureState::derive(true, false, false, 0, 999_999, 30_000);
        assert_eq!(s, CaptureState::Stalled);
    }

    #[test]
    fn derive_not_stalled_just_under_threshold() {
        let s = CaptureState::derive(true, false, false, 1_000, 1_000 + 30_000, 30_000);
        assert_eq!(s, CaptureState::Capturing);
    }

    // ---- stall threshold: 3x interval, floored at 30s ----
    #[test]
    fn stall_threshold_floors_at_30s() {
        assert_eq!(stall_threshold_ms(1), 30_000);
        assert_eq!(stall_threshold_ms(5), 30_000);
    }

    #[test]
    fn stall_threshold_scales_above_floor() {
        assert_eq!(stall_threshold_ms(20), 60_000);
    }

    // ---- CaptureGate ----
    #[test]
    fn should_capture_requires_all_three() {
        let g = CaptureGate::new(true);
        assert!(g.should_capture());
        g.set_privacy_blocked(true);
        assert!(!g.should_capture());
        g.set_privacy_blocked(false);
        g.set_lock_blocked(true);
        assert!(!g.should_capture());
        g.set_lock_blocked(false);
        g.set_wants_capture(false);
        assert!(!g.should_capture());
    }

    #[test]
    fn seconds_since_last_frame_is_none_before_first_frame() {
        let g = CaptureGate::new(true);
        assert_eq!(g.seconds_since_last_frame(1_000_000), None);
        g.stamp_frame(1_000_000);
        assert_eq!(g.seconds_since_last_frame(1_005_000), Some(5));
    }

    // ---- recompute_privacy_gate: reliability x exclusions x override ----
    struct Stub { reliable: bool }
    #[async_trait]
    impl WindowInfoProvider for Stub {
        fn name(&self) -> &'static str { "stub" }
        async fn probe(&self) -> bool { false }
        async fn start(&self) -> Result<(), WindowInfoError> { Ok(()) }
        fn current(&self) -> WindowInfo { WindowInfo::default() }
        async fn stop(&self) -> Result<(), WindowInfoError> { Ok(()) }
        fn provides_reliable_metadata(&self) -> bool { self.reliable }
    }

    fn privacy_with(apps: &[&str]) -> rewindos_core::config::PrivacyConfig {
        rewindos_core::config::PrivacyConfig {
            excluded_apps: apps.iter().map(|s| s.to_string()).collect(),
            excluded_title_patterns: vec![],
            ..Default::default()
        }
    }

    #[test]
    fn privacy_blocks_when_unreliable_and_exclusions_set() {
        let g = CaptureGate::new(true);
        recompute_privacy_gate(&g, &Stub { reliable: false }, &privacy_with(&["keepassxc"]), false);
        assert!(g.privacy_blocked());
    }

    #[test]
    fn privacy_blocks_unknown_provider_via_trait_default() {
        // A provider using the trait default (false) must block when exclusions set.
        struct Bare;
        #[async_trait]
        impl WindowInfoProvider for Bare {
            fn name(&self) -> &'static str { "bare" }
            async fn probe(&self) -> bool { false }
            async fn start(&self) -> Result<(), WindowInfoError> { Ok(()) }
            fn current(&self) -> WindowInfo { WindowInfo::default() }
            async fn stop(&self) -> Result<(), WindowInfoError> { Ok(()) }
        }
        let g = CaptureGate::new(true);
        recompute_privacy_gate(&g, &Bare, &privacy_with(&["keepassxc"]), false);
        assert!(g.privacy_blocked());
    }

    #[test]
    fn privacy_does_not_block_reliable_provider() {
        let g = CaptureGate::new(true);
        recompute_privacy_gate(&g, &Stub { reliable: true }, &privacy_with(&["keepassxc"]), false);
        assert!(!g.privacy_blocked());
    }

    #[test]
    fn privacy_does_not_block_with_empty_exclusions() {
        let g = CaptureGate::new(true);
        recompute_privacy_gate(&g, &Stub { reliable: false }, &privacy_with(&[]), false);
        assert!(!g.privacy_blocked());
    }

    #[test]
    fn privacy_override_lifts_block() {
        let g = CaptureGate::new(true);
        recompute_privacy_gate(&g, &Stub { reliable: false }, &privacy_with(&["keepassxc"]), true);
        assert!(!g.privacy_blocked());
    }
}
