import { invoke, Channel } from "@tauri-apps/api/core";
import type { AppConfig } from "@/lib/config";

export interface ProviderMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

type ChatStreamEvent =
  | { type: "token"; text: string }
  | { type: "done" }
  | { type: "error"; message: string };

export interface ProviderChatOptions {
  chat: AppConfig["chat"];
  messages: ProviderMessage[];
  signal: AbortSignal;
  onToken: (token: string) => void;
}

/** Stream a chat completion through the Rust ChatClient (no CSP/CORS limits). */
export async function providerChat(opts: ProviderChatOptions): Promise<string> {
  const streamId = crypto.randomUUID();
  let full = "";

  return new Promise<string>((resolve, reject) => {
    const onEvent = new Channel<ChatStreamEvent>();
    let settled = false;

    const onAbort = () => {
      void invoke("chat_stream_cancel", { streamId });
    };
    opts.signal.addEventListener("abort", onAbort, { once: true });

    onEvent.onmessage = (ev) => {
      if (ev.type === "token") {
        full += ev.text;
        opts.onToken(ev.text);
      } else if (ev.type === "error") {
        if (!settled) {
          settled = true;
          opts.signal.removeEventListener("abort", onAbort);
          reject(new Error(ev.message));
        }
      } else if (ev.type === "done") {
        if (!settled) {
          settled = true;
          opts.signal.removeEventListener("abort", onAbort);
          resolve(full);
        }
      }
    };

    invoke("chat_stream_completion", {
      streamId,
      chat: opts.chat,
      messages: opts.messages,
      onEvent,
    }).catch((e) => {
      if (!settled) {
        settled = true;
        opts.signal.removeEventListener("abort", onAbort);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  });
}
