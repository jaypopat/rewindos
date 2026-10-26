import { AnalyticsController, type Bootstrap } from "../../src/lib/analytics/controller";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const checkpoint = async (phase: string) => { await fetch(`/phase/${phase}`); };
async function run() {
  const bootstrap: Bootstrap = await (await fetch("/bootstrap")).json();
  let enabled = true;
  const controller = new AnalyticsController(async () => enabled ? bootstrap : { enabled: false, project: null });
  const stop = controller.start();
  await delay(2000);
  const button = document.querySelector<HTMLButtonElement>("[data-analytics-control]");
  button?.click();
  controller.setView("search");
  controller.nativeEvent({ event: "search_performed", mode: "hybrid", has_filters: true });
  controller.nativeEvent({ event: "ask_sent", provider: "ollama" });
  const unsafe = document.querySelector<HTMLElement>("#unsafe");
  if (unsafe) {
    unsafe.textContent = "CANARY_MUTATION_TEXT";
    unsafe.setAttribute("title", "CANARY_MUTATION_TITLE");
    unsafe.setAttribute("data-private", "CANARY_MUTATION_ATTRIBUTE");
    unsafe.style.backgroundImage = 'url("/CANARY_MUTATION_CSS")';
    unsafe.insertAdjacentHTML("beforeend", '<span title="CANARY_ADDED_ATTRIBUTE">CANARY_ADDED_TEXT</span><img src="/CANARY_ADDED_IMAGE">');
  }
  const input = document.querySelector<HTMLInputElement>("input");
  if (input) {
    input.value = "CANARY_INPUT_VALUE_MUTATION";
    input.setAttribute("value", "CANARY_INPUT_ATTRIBUTE_MUTATION");
    input.setAttribute("placeholder", "CANARY_PLACEHOLDER_MUTATION");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }
  const sensitive = document.querySelector("[data-analytics-sensitive]");
  sensitive?.insertAdjacentHTML("beforeend", '<div title="CANARY_BLOCKED_ATTRIBUTE">CANARY_BLOCKED_MUTATION<img src="/CANARY_BLOCKED_IMAGE"></div>');
  const portal = document.createElement("div");
  portal.innerHTML = '<img src="/CANARY_PORTAL_IMAGE"><p>CANARY_PORTAL_TEXT</p>';
  document.body.append(portal);
  button?.setAttribute("title", "CANARY_CONTROL_TITLE_MUTATION");
  button?.setAttribute("data-private", "CANARY_CONTROL_PRIVATE_MUTATION");
  document.title = "CANARY_TITLE_MUTATION";
  history.replaceState({}, "", "/CANARY_PATH?secret=CANARY_QUERY#CANARY_HASH");
  const canvas = document.querySelector("canvas");
  canvas?.getContext("2d")?.fillText("CANARY_CANVAS_PIXELS", 10, 10);
  console.error("CANARY_CONSOLE_ERROR");
  await fetch("/CANARY_NETWORK_REQUEST", { method: "POST", headers: { "x-secret": "CANARY_NETWORK_HEADER" }, body: "CANARY_NETWORK_BODY" });
  await delay(13000);
  controller.nativeEvent({ event: "search_performed", mode: "keyword", has_filters: false });
  const off = controller.consentIntent();
  enabled = false;
  controller.consentPersisted(off);
  await checkpoint("off");
  button?.click();
  controller.nativeEvent({ event: "ask_sent", provider: "custom" });
  await delay(4000);
  const on = controller.consentIntent();
  enabled = true;
  controller.consentPersisted(off);
  await checkpoint("pending-on");
  await delay(4000);
  await checkpoint("on");
  controller.consentPersisted(on);
  await delay(2000);
  button?.click();
  controller.setView("settings");
  await delay(13000);
  enabled = false;
  await controller.refresh();
  await checkpoint("external-off");
  controller.nativeEvent({ event: "ask_sent", provider: "custom" });
  await delay(4000);
  stop();
  await checkpoint("done");
}
void run().catch(async (error: unknown) => { await fetch("/failure", { method: "POST", body: String(error) }); });
