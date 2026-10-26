# Analytics

RewindOS sends usage analytics to [PostHog](https://posthog.com). The project uses them to count how many people run RewindOS, how many keep running it, and which features they use. Analytics are on by default, and one setting turns them off.

RewindOS never sends screen content, OCR text, app names, window titles, search queries, chat messages, file paths, or journal text. The JavaScript SDK owns UI events, browser metadata, and allowlisted control clicks. Session replay is hard-disabled locally. Rust owns daemon events. Both use `privacy.analytics` and the same install ID. The project also has replay disabled. This change does not alter remote settings. Native verification found that rrweb stylesheet mutations and adopted stylesheets could send content outside its text and attribute masking callbacks. Local `disable_session_recording: true` prevents recording even if the project enables it. The event hook rejects `$snapshot` too.

The event schemas and local privacy configuration are in `src/lib/analytics/privacy.ts`. The SDK version is pinned to `posthog-js 1.438.23`. Schema tests check the native bridge, UI event properties, SDK metadata, and this documentation. The native WebKit verification described below checks actual encoded payloads.

## How you are identified

When analytics are enabled and a compiled project key exists, the first bootstrap or daemon send writes a random UUID (version 4) to `~/.rewindos/install_id`. The daemon and the app both send that UUID as PostHog's `distinct_id`, so PostHog sees one person per install. RewindOS does not derive the ID from your hardware, your user name, or your host name. The native bootstrap reuses the core atomic `install_id` helper. The SDK receives this UUID in `bootstrap.distinctID` before initialization and uses it for `$device_id` too. It never calls `identify` or `alias` and never sends an unrelated JavaScript-generated person ID. SDK person processing is enabled for the install UUID. SDK event persistence is in memory. Native SDK session and window IDs remain separate from this install ID. To start over as a new install, delete the file.

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
| `app_opened` | `ui` | The first consented SDK initialization in this page lifetime. | None. |
| `view_opened` | `ui` | Navigation or a fresh SDK initialization after persisted consent. | `view` |
| `search_performed` | `ui` | You run a search from any search box. The query is never sent. | `mode`, `has_filters` |
| `ask_sent` | `ui` | A native Ask or chat action starts. The message is never sent. | `provider` |
| `$autocapture` | `ui` | You click an allowlisted fixed button. | `control`, `$event_type`, `$elements` |
| `$snapshot` | `ui` | Never sent in this build. The event hook rejects it. | Candidate replay fields are `$snapshot_data`, `$snapshot_bytes`. |
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

## SDK metadata and interaction properties

`before_send` rebuilds every event from an allowlist. Unknown events, DOM attributes, raw element text, campaign parameters, person `$set` and `$set_once` data, and arbitrary properties are dropped. Native action events accept only their exact closed shapes. Native Rust action points emit `analytics-action` to the SDK without a second HTTP sender.

UI events may include these SDK properties. Not every runtime supplies every property.

| Properties | Value |
| --- | --- |
| `token` | The compiled public PostHog project key. |
| `distinct_id`, `$device_id` | The shared random install UUID. |
| `$session_id`, `$window_id` | SDK-generated session and WebView identifiers. |
| `$lib`, `$lib_version` | SDK library name and version. |
| `$browser`, `$browser_version`, `$os`, `$os_version` | Browser or WebView and operating-system dimensions. |
| `$device_type`, `$device_model` | SDK device classification and model when available. |
| `$screen_height`, `$screen_width`, `$viewport_height`, `$viewport_width` | Display and WebView dimensions in pixels. |
| `$timezone`, `$timezone_offset`, `$time` | SDK timezone and event-time dimensions when available. |
| `$is_identified`, `$insert_id`, `$process_person_profile` | SDK identity state, deduplication identifier, and person-processing control when supplied. |
| `$current_url` | Always `https://rewindos.local/`. |
| `$pathname`, `$host`, `$title` | Always `/`, `rewindos.local`, and `RewindOS`. |
| `$referrer`, `$referring_domain` | Always empty. |

UI event envelopes include `uuid`, `event`, and `timestamp`. SDK event batches also include transport metadata such as `sent_at` and the public project key. No raw page URL, query string, fragment, title, or referrer is retained. The replay URL hook omits the source URL from replay metadata and captured navigation timing.

Autocapture records only `click` on allowlisted buttons. It masks all text and attributes, then the event hook retains only a validated `control`, `$event_type` equal to `click`, and `$elements` equal to `[{"tag_name":"button"}]`. It records no copied text, input changes, form submissions, or arbitrary buttons.

The complete `control` set is:

- `nav-dashboard`, `nav-history`, `nav-rewind`, `nav-search`, `nav-saved`, `nav-journal`, `nav-ask`, `nav-meetings`, `nav-settings`.
- `settings-general`, `settings-capture`, `settings-privacy`, `settings-ai`, `settings-meeting`, `settings-storage`, `settings-ocr`, `settings-export`.
- `open-recall`, `save-moment`.

## Why replay is disabled

Replay is hard-disabled in this build. Remote settings cannot override `disable_session_recording: true`, and the event hook drops every `$snapshot`. Nothing below describes recordings currently sent to PostHog.

The candidate masking configuration remains in `privacyConfig` for investigation. It passed the initial text, input, DOM-attribute, image, canvas, media, portal, and URL checks. An expanded native test found that rrweb sent `CANARY_STYLESHEET_MUTATION` inside a stylesheet rule and `CANARY_ADOPTED_STYLESHEET` inside adopted stylesheets. Those rules bypassed `maskTextFn` and `maskAttributeFn`, even when the style element was blocked. This failed the content boundary. Replay needs a verified fix before local enablement can be reconsidered. Remote project settings are unchanged.

The remaining paragraphs describe the candidate configuration and its limits.

The candidate recorder preserves masked shell structure, placeholder dimensions, relative timing, pointer and click positions, scroll and viewport changes, and SDK session identifiers. Explicit navigation and Settings label markers reveal only fixed IDs such as `nav-search` and `settings-privacy`. The callback returns the fixed ID rather than copying the rendered label. `$snapshot_data` contains compressed rrweb snapshots and incremental events. `$snapshot_bytes` describes their encoded size.

All other text and input values become `***`. The attribute callback masks every string-valued DOM attribute, including `title`, `name`, `placeholder`, `value`, `src`, `href`, `id`, `class`, and `style`. Only validated fixed `data-analytics-control` values survive. This applies to initial snapshots and incremental attribute changes. Hidden and file inputs are blocked altogether.

Content views for Search, Home, History, Rewind, Ask, Saved, Journal, and Meetings are blocked as subtrees. Settings fields and errors are blocked. Status panels and banners are blocked. Portals outside the React root are blocked by default. Images, screenshots, canvas, media, iframes, objects, scripts, links, styles, and the document head are blocked globally. A blocked subtree becomes a placeholder, so its child text, attributes, pixels, and asset URLs do not enter snapshots.

Console recording, exception autocapture, performance and network capture, network request and response headers and bodies, canvas recording, cross-origin iframe recording, JSON-LD, font collection, and stylesheet inlining are disabled. The network masking callback returns no request data. Surveys, product tours, conversations, web experiments, heatmaps, rage clicks, and dead clicks are disabled too. The pinned SDK registry retains only autocapture and the locally disabled session recorder. It omits separate structured-log, metric, and WebMCP extensions, so remote structured-log configuration cannot install a console recorder. Log and metric pre-send filters also reject every record.

Masking `class` and `style` and blocking stylesheets reduces replay fidelity. These recordings describe app-shell interaction, not the user's screen history. Native payload verification failed on stylesheet canaries, so these measures are insufficient to enable replay. Visual playback in the PostHog viewer has not been verified.

## When events are sent

The daemon sends immediately, reads the config file before each send, and drops failed events. The SDK batches UI events in memory on its own schedule, normally about three seconds for events, and uses its own retries and page-lifecycle delivery. The disabled candidate recorder has its own SDK buffering. RewindOS has no Rust UI queue, UI timer sender, or blocking exit flush.

The SDK is bundled through `posthog-js/full/no-external`, including its recorder. It loads no remote JavaScript. Tauri keeps its existing CSP restrictions and adds only US and EU PostHog ingestion and configuration hosts to `connect-src`. The default compiled host is `https://us.i.posthog.com`; EU builds can use `https://eu.i.posthog.com`. Configuration JSON comes from the corresponding `us-assets.i.posthog.com` or `eu-assets.i.posthog.com` host. A custom compiled host also needs an explicit CSP update.

A build without a compiled `REWINDOS_POSTHOG_KEY` never initializes the SDK or sends analytics. An empty key counts as absent. Opted-out and no-key bootstraps do not create an install ID.

## Turn analytics off

In the app, open **Settings**, then **Privacy**, and turn off **Share anonymous usage analytics**. This synchronously stops frontend capture and recording and discards queued frontend data before any pending or debounced Settings save. A request already handed to the network cannot be recalled.

Consent transitions use the existing ordered immediate save queue. A newer transition invalidates older bootstrap responses and older save acknowledgments. Opt-in waits for the latest explicit consent save to succeed and for a fresh native bootstrap. A failed consent save keeps frontend analytics stopped for this page lifetime until an explicit consent save succeeds. Reload reads the actual persisted setting. Daemon consent follows the last successfully persisted file, so a failed opt-out save must be retried to stop daemon events.

The pinned SDK's opt-out API does not itself discard queued requests. The local teardown adapter discards recorder buffers, disables transport while draining SDK event and retry queues, and shuts down the retired instance. It never reuses that instance. The SDK's own stored consent is synchronized to the persisted native setting before any new UI event.

Or set the following in `~/.rewindos/config.toml`:

```toml
[privacy]
analytics = false
```

The frontend polls native bootstrap every second. A config-file opt-out or unreadable config stops frontend capture at the next successful poll response, normally within one second plus IPC and filesystem time. Suspended or busy WebViews can take longer. Poll failures also stop the frontend. The daemon checks the file before its next send. No restart is required. There is no native consent event stream whose delayed messages could restore stale consent.

## Reproduce native verification

Run the following in the repository worktree. It requires Python GI, GTK 3, WebKit2 4.1, Bun, and an available display.

```sh
WEBKIT_DISABLE_COMPOSITING_MODE=1 WEBKIT_DISABLE_DMABUF_RENDERER=1 LIBGL_ALWAYS_SOFTWARE=1 /usr/bin/python3 scripts/analytics/native_webkit.py
```

The harness bundles the production controller and privacy configuration. An ephemeral native WebKit view loads only synthetic content. A loopback fake PostHog requests replay and structured console logging with deliberately weaker remote privacy settings. The production configuration must keep replay disabled and omit content-bearing extensions. The fixture tests malicious text, inputs, attributes, image and media URLs, canvas, portals, metadata, and DOM mutations, along with fixed navigation interactions and consent ordering. The first event batch receives a synthetic HTTP 503 with a delayed retry, so opt-out must discard the SDK retry as well as newly queued events. It decodes HTTP compression and nested compressed rrweb fields, checks for secret canaries and unexpected snapshots, and checks that opted-out traffic stops. Initial and incremental snapshots from the failed candidate run are retained as local diagnostic evidence, not as a passing replay verification.

`.audit/analytics-native/report.json` contains assertion results. `.audit/analytics-native/payloads.json` contains the decoded synthetic requests. The generated `fixture.js` is a local build artifact. The harness never uses the real project, real user content, or remote project settings. Payload verification does not verify playback in the PostHog viewer.
