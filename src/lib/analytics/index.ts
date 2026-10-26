import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { AnalyticsController, type Bootstrap } from "./controller";

export const analytics = new AnalyticsController(() => invoke<Bootstrap>("analytics_bootstrap"));

export function startAnalytics() {
  let stopped = false;
  const stop = analytics.start();
  const subscription = listen<unknown>("analytics-action", ({ payload }) => analytics.nativeEvent(payload));
  void subscription.then((unlisten) => { if (stopped) unlisten(); }).catch(() => {});
  return () => {
    stopped = true;
    stop();
    void subscription.then((unlisten) => unlisten()).catch(() => {});
  };
}
