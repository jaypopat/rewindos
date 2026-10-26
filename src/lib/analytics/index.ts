import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { AnalyticsController, type Bootstrap } from "./controller";

export const analytics = new AnalyticsController(() => invoke<Bootstrap>("analytics_bootstrap"));

export function startAnalytics() {
  let stopped = false;
  let unlisten: (() => void) | undefined;
  const stop = analytics.start();
  void listen<unknown>("analytics-action", ({ payload }) => {
    if (!stopped) analytics.nativeEvent(payload);
  }).then((unsubscribe) => {
    if (stopped) unsubscribe();
    else unlisten = unsubscribe;
  }).catch(() => {});
  return () => {
    stopped = true;
    stop();
    unlisten?.();
  };
}
