# update-proxy

Cloudflare Worker that counts distinct active devices and serves the public
usage-transparency page. Two client signals feed it:

- the desktop app's update check (`src-tauri/src/updater.rs`, every 6 h via
  `useUpdateCheck`) — also edge-cached so it shields GitHub's rate limit;
- the capture daemon's heartbeat (`crates/rewindos-daemon/src/heartbeat.rs`,
  every 6 h while capture runs) — so the signal means "install in use," not
  "window was open."

Clients send their app version and desktop env (`X-RewindOS-Version` /
`X-RewindOS-Platform`); the shared builder is `rewindos_core::usage::headers()`.

```
GET /repos/jaypopat/rewindos/releases/latest   edge-cached (5 min) passthrough of api.github.com; counts the device
GET /beat                                       daemon heartbeat; counts the device, returns {ok:true}
GET /stats   (also /)                           public transparency page (method-led, no live figures)
GET /stats.json                                 the raw counts, full history
```

**How the count works.** The `CheckCounter` durable object hashes the caller's
IP with a daily input + a random server-only salt, dedupes within the day
(`seen` table), and keeps only `daily (day, version, platform, checks, devices)`.
Same device same day/version/platform → one device (the UI check and daemon
beat collapse together). Different days use a different hash, so a device can't
be linked across days; today's hashes are deleted when the day closes, leaving
only the counts. So `devices` is **distinct active devices per bucket (DAU)**,
not a fudged estimate. `version`/`platform` are client-reported install
attributes, normalized + allowlisted server-side (junk → `unknown`/`other`) and
stored as aggregate counts only. Published at
[/stats](https://rewindos-updates.incident-agent.workers.dev/stats) (method) and
`/stats.json` (data); opt out client-side with `[privacy] usage_heartbeat = false`.

**Rate limits.** The edge cache means GitHub sees ~1 request per colo per
5 min regardless of client count, so no token is needed.

The client falls back to `api.github.com` directly on any proxy failure, so
updates never depend on this worker being up.

## Deploy

```bash
bunx wrangler deploy
```

Live at: https://rewindos-updates.incident-agent.workers.dev
(`rewindos_core::usage::PROXY_BASE` must match.)
