import { PostHog } from "posthog-js/full/no-external";
import type { View } from "@/components/Sidebar";
import { parseNativeEvent, privacyConfig, sanitizeEvent } from "./privacy";

// Only these bundled extensions may react to remote project configuration.
const bundledExtensions = PostHog.__defaultExtensionClasses;
PostHog.__defaultExtensionClasses = {
  autocapture: bundledExtensions?.autocapture,
  sessionRecording: bundledExtensions?.sessionRecording,
};

export interface Bootstrap {
  enabled: boolean;
  project: null | {
    endpoint: { host: string; api_key: string };
    distinct_id: string;
    common: { app_version: string; desktop: string; distro: string; source: "ui"; $geoip_disable: true };
  };
}

// posthog-js 1.438.23 opt-out leaves queued requests alive. Never reuse a retired instance.
export function discardSdk(sdk: PostHog) {
  sdk.opt_out_capturing();
  sdk.sessionRecording?.dispose({ discardBufferedEvents: true });
  sdk.__loaded = false;
  sdk._requestQueue?.unload();
  sdk._retryQueue?.unload();
  sdk.__loaded = true;
  void sdk.shutdown();
  sdk.__loaded = false;
  sdk.sessionManager?.destroy();
}

export class AnalyticsController {
  private sdk: PostHog | null = null;
  private running = false;
  private epoch = 0;
  private request = 0;
  private pendingConsent: number | null = null;
  private view: View = "dashboard";
  private appOpened = false;
  private projectId: string | null = null;

  constructor(private readonly bootstrap: () => Promise<Bootstrap>) {}

  start() {
    this.running = true;
    void this.refresh();
    const timer = setInterval(() => { void this.refresh(); }, 1000);
    return () => {
      clearInterval(timer);
      this.running = false;
      this.epoch++;
      this.stop();
    };
  }

  consentIntent() {
    this.pendingConsent = ++this.epoch;
    this.stop();
    return this.pendingConsent;
  }

  consentPersisted(ticket: number) {
    if (ticket !== this.pendingConsent) return;
    this.pendingConsent = null;
    this.epoch++;
    void this.refresh();
  }

  async refresh() {
    const epoch = this.epoch;
    const request = ++this.request;
    try {
      const bootstrap = await this.bootstrap();
      if (!this.running || epoch !== this.epoch || request !== this.request || this.pendingConsent !== null) return;
      if (!bootstrap.enabled || !bootstrap.project) { this.stop(); return; }
      const project = bootstrap.project;
      const projectId = JSON.stringify([project.endpoint, project.distinct_id]);
      if (this.sdk && this.projectId === projectId) return;
      this.stop();
      const sdk = new PostHog();
      this.sdk = sdk;
      this.projectId = projectId;
      sdk.init(project.endpoint.api_key, {
        ...privacyConfig(), api_host: project.endpoint.host,
        bootstrap: { distinctID: project.distinct_id, isIdentifiedID: false },
        get_device_id: () => project.distinct_id,
        before_send: (event) => this.sdk === sdk && this.running && this.pendingConsent === null
          ? sanitizeEvent(event, project.common) : null,
      });
      sdk.opt_in_capturing({ captureEventName: false });
      if (!this.appOpened) { sdk.capture("app_opened"); this.appOpened = true; }
      sdk.capture("view_opened", { view: this.view });
    } catch {
      if (epoch === this.epoch && request === this.request) this.stop();
    }
  }

  setView(view: View) {
    if (view === this.view) return;
    this.view = view;
    this.sdk?.capture("view_opened", { view });
  }

  nativeEvent(value: unknown) {
    const parsed = parseNativeEvent(value);
    if (!parsed) return;
    const { event, ...properties } = parsed;
    this.sdk?.capture(event, properties);
  }

  private stop() {
    const sdk = this.sdk;
    this.sdk = null;
    this.projectId = null;
    if (sdk) discardSdk(sdk);
  }
}
