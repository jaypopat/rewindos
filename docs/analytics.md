# Analytics

RewindOS sends usage analytics to [PostHog](https://posthog.com). The project uses them to count how many people run RewindOS, how many keep running it, and which features they use. Analytics are on by default, and one setting turns them off.

RewindOS never sends screen content, OCR text, app names, window titles, search queries, chat messages, file paths, or journal text. This page lists every event and every property RewindOS can send. A test in `crates/rewindos-core/src/analytics.rs` fails the build when the code sends an event or a property that this page does not list.

## How you are identified

The first time RewindOS sends an event, it writes a random UUID (version 4) to `~/.rewindos/install_id`. The daemon and the app both send that UUID as PostHog's `distinct_id`, so PostHog sees one person per install. RewindOS does not derive the ID from your hardware, your user name, or your host name. To start over as a new install, delete the file.

Every event sets `$geoip_disable`, which tells PostHog not to look up a location from your IP address. RewindOS never sends your IP address as a property. PostHog still receives the connection's IP address, as every server you connect to does.

## Properties on every event

| Property | Value |
| --- | --- |
| `app_version` | The RewindOS version, for example `1.0.13`. |
| `desktop` | `kde`, `gnome`, `hyprland`, `sway`, `cosmic`, or `other`, read from `XDG_CURRENT_DESKTOP`. |
| `distro` | The `ID` line of `/etc/os-release`, for example `ubuntu` or `arch`. |
| `source` | `daemon` or `ui`, the process that sent the event. |
| `$geoip_disable` | Always `true`. |

## Events

| Event | Source | Sent when | Properties |
| --- | --- | --- | --- |
| `app_opened` | `ui` | The app starts. | None. |
| `view_opened` | `ui` | The app shows a view, including the first view at start. | `view` |
| `search_performed` | `ui` | You run a search from any search box. The query is never sent. | `mode`, `has_filters` |
| `ask_sent` | `ui` | You send a question in Ask. The message is never sent. | `provider` |
| `private_mode_toggled` | `daemon` | Private Mode turns on or off, from the tray or the app. | `enabled` |
| `daemon_heartbeat` | `daemon` | 30 seconds after the daemon starts, then every 6 hours. | See the next table. |

| Property | Event | Value |
| --- | --- | --- |
| `view` | `view_opened` | `dashboard`, `history`, `rewind`, `search`, `saved`, `journal`, `ask`, `meetings`, or `settings`. |
| `mode` | `search_performed` | `keyword`, or `hybrid` when semantic search ran too. |
| `has_filters` | `search_performed` | `true` when a date or app filter was set. |
| `provider` | `ask_sent` | `ollama`, `lmstudio`, `openai`, `openrouter`, `claude_code`, or `custom`. |
| `enabled` | `private_mode_toggled` | `true` when Private Mode turned on. |

`daemon_heartbeat` reports which features are on.

| Property | Value |
| --- | --- |
| `capture_enabled` | `enabled` under `[capture]`. |
| `semantic_enabled` | `true` when the daemon found Ollama at startup and runs semantic search. |
| `chat_enabled` | `enabled` under `[chat]`. |
| `chat_provider` | `provider` under `[chat]`: `ollama`, `lmstudio`, `openai`, `openrouter`, or `custom`. |
| `agentic_tools` | `agentic_tools` under `[chat]`. |
| `meeting_enabled` | `enabled` under `[meeting]`. |
| `vault_export_enabled` | `enabled` under `[vault_export]`. |
| `ocr_engine` | `tesseract` or `paddleocr`. |
| `capture_interval_s` | `interval_seconds` under `[capture]`. |
| `private_mode` | `true` when Private Mode is on. |
| `screenshots_today_bucket` | Screenshots taken since local midnight: `0`, `1-99`, `100-999`, or `1000+`. |

## When events are sent

The daemon sends each event when it happens. The app holds its events in memory and sends them every 60 seconds and when you quit. When a send fails, RewindOS drops the events and does not retry. A build without a PostHog key compiled in, such as a build from source, sends nothing.

## Turn analytics off

In the app, open **Settings**, then **Privacy**, and turn off **Share anonymous usage analytics**.

Or set `analytics` to `false` under `[privacy]` in `~/.rewindos/config.toml`:

```toml
[privacy]
analytics = false
```

RewindOS reads the setting before every send, so you don't need to restart. A batch blocked by this setting is discarded. Turning the Settings switch off also immediately clears the app's pending events.
