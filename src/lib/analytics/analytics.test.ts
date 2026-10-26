import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PostHog } from "posthog-js/full/no-external";
import type { CaptureResult } from "posthog-js";
import { AnalyticsController, type Bootstrap } from "./controller";
import { BLOCK_SELECTOR, CONTROLS, parseNativeEvent, privacyConfig, SAFE_URL, sanitizeEvent, VIEWS } from "./privacy";

const project: NonNullable<Bootstrap["project"]> = {
  endpoint: { host: "http://127.0.0.1:9", api_key: "phc_test" },
  distinct_id: "6f1c2a54-93b5-4d0e-9a51-2b7c8e1f0d3a",
  common: { app_version: "test", desktop: "other", distro: "test", source: "ui", $geoip_disable: true },
};
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ sessionRecording: false, hasFeatureFlags: false }), { status: 200 })));
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("SDK lifecycle with real PostHog initialization", () => {
  it.each([{ enabled: false, project: null }, { enabled: true, project: null }])("never initializes SDK without consent and a key", async (bootstrap) => {
    const init = vi.spyOn(PostHog.prototype, "init");
    const controller = new AnalyticsController(async () => bootstrap);
    const stop = controller.start();
    await flush();
    controller.nativeEvent({ event: "ask_sent", provider: "ollama" });
    expect(init).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    stop();
  });

  it("uses the daemon UUID before the first event, without identify or alias", async () => {
    const capture = vi.spyOn(PostHog.prototype, "capture");
    const identify = vi.spyOn(PostHog.prototype, "identify");
    const alias = vi.spyOn(PostHog.prototype, "alias");
    const controller = new AnalyticsController(async () => ({ enabled: true, project }));
    controller.setView("journal");
    const stop = controller.start();
    await flush();
    const app = capture.mock.results.find((result) => result.value?.event === "app_opened")?.value;
    expect(app?.properties).toMatchObject({ distinct_id: project.distinct_id, $device_id: project.distinct_id, token: "phc_test", source: "ui" });
    expect(capture.mock.results.some((result) => result.value?.properties?.view === "journal")).toBe(true);
    expect(identify).not.toHaveBeenCalled();
    expect(alias).not.toHaveBeenCalled();
    stop();
  });

  it("stops immediately and waits for the newest consent save before opt-in", async () => {
    const capture = vi.spyOn(PostHog.prototype, "capture");
    const controller = new AnalyticsController(async () => ({ enabled: true, project }));
    const stop = controller.start();
    await flush();
    const off = controller.consentIntent();
    const on = controller.consentIntent();
    const count = capture.mock.calls.length;
    controller.nativeEvent({ event: "ask_sent", provider: "custom" });
    controller.consentPersisted(off);
    await controller.refresh();
    await vi.advanceTimersByTimeAsync(5000);
    expect(capture).toHaveBeenCalledTimes(count);
    controller.consentPersisted(on);
    await flush();
    controller.nativeEvent({ event: "ask_sent", provider: "openai" });
    expect(capture.mock.results.some((result) => result.value?.properties?.provider === "openai")).toBe(true);
    expect(capture.mock.results.some((result) => result.value?.properties?.provider === "custom")).toBe(false);
    stop();
  });

  it("ignores late bootstrap responses after consent changes and unmount", async () => {
    const init = vi.spyOn(PostHog.prototype, "init");
    let resolve!: (value: Bootstrap) => void;
    const controller = new AnalyticsController(() => new Promise((done) => { resolve = done; }));
    const stop = controller.start();
    controller.consentIntent();
    resolve({ enabled: true, project });
    await flush();
    expect(init).not.toHaveBeenCalled();
    const refresh = controller.refresh();
    stop();
    resolve({ enabled: true, project });
    await refresh;
    expect(init).not.toHaveBeenCalled();
  });

  it("reads external opt-outs, fails closed on errors, and drops malformed bridge events", async () => {
    const capture = vi.spyOn(PostHog.prototype, "capture");
    let enabled = true;
    let fail = false;
    const controller = new AnalyticsController(async () => {
      if (fail) throw new Error("config unavailable");
      return { enabled, project: enabled ? project : null };
    });
    const stop = controller.start();
    await flush();
    const count = capture.mock.calls.length;
    controller.nativeEvent({ event: "ask_sent", provider: "custom", prompt: "secret" });
    expect(capture).toHaveBeenCalledTimes(count);
    enabled = false;
    await vi.advanceTimersByTimeAsync(1000);
    controller.nativeEvent({ event: "ask_sent", provider: "custom" });
    expect(capture).toHaveBeenCalledTimes(count);
    enabled = true;
    await controller.refresh();
    fail = true;
    await controller.refresh();
    const afterFailure = capture.mock.calls.length;
    controller.nativeEvent({ event: "ask_sent", provider: "custom" });
    expect(capture).toHaveBeenCalledTimes(afterFailure);
    stop();
  });
});

describe("content boundary", () => {
  it("accepts only exact native action shapes", () => {
    expect(parseNativeEvent({ event: "search_performed", mode: "hybrid", has_filters: true })).toEqual({ event: "search_performed", mode: "hybrid", has_filters: true });
    for (const value of [null, "ask_sent", { event: "app_opened" }, { event: "ask_sent", provider: "unknown" }, { event: "ask_sent", provider: "custom", prompt: "secret" }, { event: "search_performed", mode: "keyword", has_filters: "true" }]) {
      expect(parseNativeEvent(value)).toBeNull();
    }
  });

  it("drops raw URL, title, referrer, DOM attributes and person metadata", () => {
    const input: CaptureResult = { uuid: "id", event: "view_opened", $set: { secret: "secret" }, $set_once: { secret: "secret" }, properties: {
      token: "public", distinct_id: "install", $session_id: "session", $browser: "Safari", $viewport_width: 900,
      view: "ask", $current_url: "secret", $title: "secret", $referrer: "secret", $initial_referrer: "secret", path: "secret", $elements: [{ attr__title: "secret" }],
    } };
    expect(sanitizeEvent(input, project.common)).toEqual({ uuid: "id", event: "view_opened", timestamp: undefined, properties: {
      token: "public", distinct_id: "install", $session_id: "session", $browser: "Safari", $viewport_width: 900,
      ...project.common, view: "ask", $current_url: SAFE_URL, $pathname: "/", $host: "rewindos.local", $title: "RewindOS", $referrer: "", $referring_domain: "",
    } });
  });

  it("allows only fixed semantic controls and reconstructs interaction properties", () => {
    const event: CaptureResult = { uuid: "id", event: "$autocapture", properties: { control: "nav-search", $event_type: "click", $el_text: "secret", $elements: [{ attr__href: "secret" }] } };
    expect(sanitizeEvent(event, {})?.properties).toMatchObject({ control: "nav-search", $elements: [{ tag_name: "button" }] });
    expect(JSON.stringify(sanitizeEvent(event, {}))).not.toContain("secret");
    expect(sanitizeEvent({ ...event, properties: { ...event.properties, control: "user-button" } }, {})).toBeNull();
    expect(sanitizeEvent({ ...event, event: "$exception" }, {})).toBeNull();
    expect(CONTROLS).toContain("settings-privacy");
    expect(CONTROLS).toContain("open-recall");
    expect(CONTROLS).not.toContain("copy");
    expect(VIEWS).toHaveLength(9);
  });

  it("masks initial and mutated attributes and inputs, blocks pixels and portals", () => {
    document.body.innerHTML = '<div id="root"><button data-analytics-control="nav-search" title="secret"><span data-replay-label="nav-search">secret</span></button><img src="secret"><canvas></canvas><div data-analytics-sensitive>secret</div></div><aside>secret</aside>';
    const options = privacyConfig().session_recording!;
    const button = document.querySelector("button")!;
    const label = document.querySelector("span")!;
    expect(options.maskTextFn?.("secret", label)).toBe("nav-search");
    expect(options.maskTextFn?.("secret", button)).toBe("***");
    expect(options.maskAttributeFn?.("title", "secret", button)).toBe("***");
    button.setAttribute("title", "mutated-secret");
    expect(options.maskAttributeFn?.("title", button.title, button)).toBe("***");
    expect(options.maskAttributeFn?.("data-analytics-control", "nav-search", button)).toBe("nav-search");
    for (const selector of ["img", "canvas", "[data-analytics-sensitive]", "aside"]) expect(document.querySelector(selector)?.matches(BLOCK_SELECTOR)).toBe(true);
    expect(options.maskInputFn?.("secret")).toBe("***");
    expect(options.recordBody).toBe(false);
    expect(options.recordHeaders).toBe(false);
    expect(options.captureCanvas?.recordCanvas).toBe(false);
    expect(options.maskCapturedNetworkRequestFn).toBeTypeOf("function");
    document.body.innerHTML = "";
  });
});
