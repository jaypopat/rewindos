# Native analytics evidence

All captures use synthetic fixtures, a fake project key, a fixed synthetic install UUID, and a loopback receiver. They contain no user data and make no requests to the real PostHog project.

- `native-report.json` records the final production configuration with replay hard-disabled. All 18 assertions pass in WebKitGTK 2.52.6. The capture has nine UI events, no secret canaries, and zero snapshots. A synthetic HTTP 503 leaves a retry pending until opt-out, which discards it without resending. Event capture resumes only after the latest consent save acknowledgment.
- `native-payloads.json` contains the actual decoded final requests, including browser, viewport, SDK identity, fixed-control, and native-action properties. The receiver rejects the first batch deliberately.
- `replay-blocker.json` preserves the actual stylesheet rule events that escaped the candidate recorder's masking. This failed replay verification. It contains only synthetic canaries. Replay remains disabled locally and `$snapshot` is rejected by the event hook.
- `source-hashes.json` identifies the production controller, configuration, fixture, and receiver used for the final native run.

Reproduce the current check from the repository root with:

```sh
WEBKIT_DISABLE_COMPOSITING_MODE=1 WEBKIT_DISABLE_DMABUF_RENDERER=1 LIBGL_ALWAYS_SOFTWARE=1 /usr/bin/python3 scripts/analytics/native_webkit.py
```

The rerun writes its report and full decoded traffic to `.audit/analytics-native/`. The original failed candidate's full decoded payloads and executable bundle remain locally in `.audit/analytics-native-final/`. The harness uses the current production privacy configuration without a replay-enabling test override. Reproducing candidate recordings requires a code change and a new privacy audit.

This evidence verifies native SDK payloads and consent behavior. It does not verify playback in the PostHog viewer or a full Tauri app session.
