import type { CaptureResult, PostHogConfig } from "posthog-js";

export const VIEWS = ["dashboard", "history", "rewind", "search", "saved", "journal", "ask", "meetings", "settings"] as const;
export const SETTINGS_TABS = ["general", "capture", "privacy", "ai", "meeting", "storage", "ocr", "export"] as const;
export const CONTROLS = [
  ...VIEWS.map((view) => `nav-${view}`),
  ...SETTINGS_TABS.map((tab) => `settings-${tab}`),
  "open-recall", "save-moment",
];
export const SAFE_URL = "https://rewindos.local/";
export const BLOCK_SELECTOR = [
  "[data-analytics-sensitive]", "body > :not(#root)",
  "head", "script", "style", "link", "img", "picture", "canvas", "video", "audio", "source", "iframe", "object", "embed",
  'input[type="hidden"]', 'input[type="file"]',
].join(", ");

export type NativeEvent =
  | { event: "search_performed"; mode: "keyword" | "hybrid"; has_filters: boolean }
  | { event: "ask_sent"; provider: "ollama" | "lmstudio" | "openai" | "openrouter" | "claude_code" | "custom" };

export function parseNativeEvent(value: unknown): NativeEvent | null {
  if (!value || typeof value !== "object" || !("event" in value)) return null;
  if (value.event === "search_performed" && "mode" in value && "has_filters" in value &&
    (value.mode === "keyword" || value.mode === "hybrid") && typeof value.has_filters === "boolean" && Object.keys(value).length === 3) {
    return { event: value.event, mode: value.mode, has_filters: value.has_filters };
  }
  if (value.event === "ask_sent" && "provider" in value && Object.keys(value).length === 2) {
    switch (value.provider) {
      case "ollama": case "lmstudio": case "openai": case "openrouter": case "claude_code": case "custom":
        return { event: value.event, provider: value.provider };
    }
  }
  return null;
}

const SDK_PROPERTIES = [
  "token", "distinct_id", "$device_id", "$session_id", "$window_id", "$lib", "$lib_version", "$browser", "$browser_version",
  "$os", "$os_version", "$device_type", "$device_model", "$screen_height", "$screen_width", "$viewport_height", "$viewport_width",
  "$timezone", "$timezone_offset", "$time", "$is_identified", "$insert_id", "$process_person_profile",
];

function fixedProperties(event: CaptureResult): Record<string, unknown> | null {
  const props = event.properties;
  switch (event.event) {
    case "app_opened": return {};
    case "view_opened": return VIEWS.some((view) => view === props.view) ? { view: props.view } : null;
    case "search_performed": case "ask_sent": {
      const parsed = parseNativeEvent(event.event === "search_performed"
        ? { event: event.event, mode: props.mode, has_filters: props.has_filters }
        : { event: event.event, provider: props.provider });
      if (!parsed) return null;
      const { event: _name, ...properties } = parsed;
      return properties;
    }
    case "$autocapture":
      return props.$event_type === "click" && CONTROLS.includes(props.control)
        ? { control: props.control, $event_type: "click", $elements: [{ tag_name: "button" }] }
        : null;
    case "$snapshot": return { $snapshot_data: props.$snapshot_data, $snapshot_bytes: props.$snapshot_bytes };
    default: return null;
  }
}

export function sanitizeEvent(event: CaptureResult, common: Record<string, unknown>): CaptureResult | null {
  const fixed = fixedProperties(event);
  if (!fixed) return null;
  const properties: Record<string, unknown> = {};
  for (const key of SDK_PROPERTIES) {
    const value: unknown = event.properties[key];
    if (typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) properties[key] = value;
  }
  return {
    uuid: event.uuid, event: event.event, timestamp: event.timestamp,
    properties: { ...properties, ...common, ...fixed, $current_url: SAFE_URL, $pathname: "/", $host: "rewindos.local", $title: "RewindOS", $referrer: "", $referring_domain: "", $geoip_disable: true },
  };
}

export function privacyConfig(): Partial<PostHogConfig> {
  return {
    defaults: "2026-01-30",
    persistence: "memory",
    opt_out_capturing_by_default: true,
    person_profiles: "always",
    capture_pageview: false, capture_pageleave: false,
    save_campaign_params: false, save_referrer: false,
    disable_capture_url_hashes: true,
    get_current_url: () => SAFE_URL,
    mask_all_text: true, mask_all_element_attributes: true,
    autocapture: {
      dom_event_allowlist: ["click"], element_allowlist: ["button"],
      css_selector_allowlist: CONTROLS.map((id) => `[data-analytics-control="${id}"]`),
      css_selector_ignorelist: ["[data-analytics-sensitive]", ".ph-no-capture", ".ph-no-autocapture", "[data-ph-no-autocapture]"],
      capture_copied_text: false,
    },
    rageclick: false, capture_dead_clicks: false, enable_heatmaps: false,
    capture_exceptions: false, capture_performance: false,
    enable_recording_console_log: false,
    disable_external_dependency_loading: true,
    disable_surveys: true, disable_product_tours: true, disable_conversations: true, disable_web_experiments: true,
    advanced_disable_feature_flags: true, advanced_disable_toolbar_metrics: true,
    remote_config_refresh_interval_ms: 0,
    session_recording: {
      blockSelector: BLOCK_SELECTOR,
      maskAllInputs: true, maskInputFn: () => "***",
      maskTextSelector: "*",
      maskTextFn: (_text, element) => {
        const label = element?.getAttribute("data-replay-label");
        return label && CONTROLS.includes(label) ? label : "***";
      },
      maskAllElementAttributes: false,
      maskAttributeFn: (name, _value, element) => {
        const control = element?.getAttribute("data-analytics-control");
        return name === "data-analytics-control" && control && CONTROLS.includes(control) ? control : "***";
      },
      captureJsonLd: false, collectFonts: false, inlineStylesheet: false,
      recordCrossOriginIframes: false, recordHeaders: false, recordBody: false,
      captureCanvas: { recordCanvas: false }, canvasCapture: { maskRegionsFn: () => null },
      maskCapturedNetworkRequestFn: () => null,
    },
  };
}
