import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type React from "react";

vi.mock("@/lib/api", () => ({
  askClaudeCancel: vi.fn(async () => {}),
  askClaudeStream: vi.fn(async () => {}),
  askClaudeStreamWithAttachments: vi.fn(async () => {}),
  buildChatContext: vi.fn(async () => ({ context: "" })),
  claudeDetect: vi.fn(async () => ({ available: false, mcp_registered: false })),
  createChat: vi.fn(async () => 1),
  deleteMessagesAfter: vi.fn(async () => {}),
  getChatMessages: vi.fn(async () => []),
  getConfig: vi.fn(async () => ({
    chat: {
      model: "qwen2.5:3b",
      base_url: "http://127.0.0.1:11434/v1",
      api_key: "",
      temperature: 0.2,
      max_history_messages: 10,
    },
  })),
  getScreenshotsByIds: vi.fn(async () => []),
  listChats: vi.fn(async () => []),
  setModel: vi.fn(async () => {}),
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => {}),
  convertFileSrc: vi.fn((path: string) => `asset://localhost/${path}`),
}));
vi.mock("@/lib/provider-chat", () => ({ providerChat: vi.fn() }));

import { AskProvider, useAskChat } from "./AskContext";
import { providerChat } from "@/lib/provider-chat";
import { invoke } from "@tauri-apps/api/core";

function makeWrapper() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={client}>
      <AskProvider>{children}</AskProvider>
    </QueryClientProvider>
  );
  return { client, wrapper };
}

describe("AskContext abort handling", () => {
  beforeEach(() => vi.clearAllMocks());

  it("persists the streamed partial text when the stream aborts", async () => {
    vi.mocked(providerChat).mockImplementation(async (opts) => {
      opts.onToken("partial ");
      opts.onToken("answer");
      throw new DOMException("aborted", "AbortError");
    });

    const { wrapper } = makeWrapper();
    const { result } = renderHook(() => useAskChat(), { wrapper });

    await act(async () => {
      await result.current.sendMessage("hello");
    });

    // user message + aborted-partial assistant message both persisted
    expect(invoke).toHaveBeenCalledWith(
      "append_chat_message",
      expect.objectContaining({
        role: "assistant",
        contentJson: JSON.stringify({ text: "partial answer" }),
      }),
    );
    expect(result.current.isStreaming).toBe(false);
    expect(result.current.error).toBeNull();
  });
});
